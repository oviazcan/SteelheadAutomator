# `bulk-upload` — bitácora completa

Versiones documentadas: 1.0.0 → 1.5.20 (+ extensión 1.6.0 → 1.6.2 + VBA Module1 v14). Para deploy y reglas generales, ver `../../CLAUDE.md`.

## Add 2026-07-13 (1.5.32) — aviso de REEMPLAZO de specs en el preview
El operador podía sorprenderse: usar `-` en cualquiera de las 4 celdas de spec activa el **archive sentinel** (`hasArchiveSentinel`, `bulk-upload.js:5430`) → no solo agrega las specs listadas, sino que **archiva TODAS las que el PN ya tenga y no estén en el CSV** (reemplazo, no suma; solo borra en PN existentes). Fix: banner ámbar en `showPreview` (bajo la línea de conteos, junto al badge de intención F5) que cuenta las filas con `-` en specs y cuántas son PN existentes, y aclara "deja la celda VACÍA si solo quieres agregar". Mismo criterio de detección que la ejecución (`part.specs.some(s => s.name === '-')`). Aviso puro de UI, no toca la lógica de archivado. `renderPreview` no rompe si falla (try/catch).

> **Spec y plan de la 1.5.20:** [`docs/superpowers/specs/2026-06-04-bulk-upload-actualizacion-precios-y-control-cambios-design.md`](../superpowers/specs/2026-06-04-bulk-upload-actualizacion-precios-y-control-cambios-design.md) · [`docs/superpowers/plans/2026-06-04-bulk-upload-precios-control-cambios.md`](../superpowers/plans/2026-06-04-bulk-upload-precios-control-cambios.md)

## Sesión 2026-07-06/07 — Carga por Id SH: hash rotado, fix de precio no deseado, robustez y fetch dirigido

> Nota de drift: las entradas del **2026-07-03** (bugs en cadena del flujo Id SH: VBA `ExportarCSV` CSV vacío → v15.4, validador JS "sin Cliente", y "DUPLICAR vs MODIFICAR") viven en `stash@{0}` (el WIP de `feat/hash-autopilot` que el auto-deploy de hashes stasheó al mover el repo a `main`). Pendiente consolidarlas aquí. Los fixes ESTÁN deployados en producción; solo la doc quedó en el stash.

Cuatro frentes, en orden de aparición:

**1. Release de Steelhead rotó ~8 hashes (config 1.7.64).** Una carga por Id SH falló con 447× `GetPartNumber: "Must provide a query string"` en el apply. NO era el fix de idSh: solo hizo que el flujo LLEGARA al apply (que usa GetPartNumber intensivamente) y destapó la rotación. Detalle en `docs/api/hash-validation-log.md` (2026-07-06). Actualizados: GetPartNumber, InvoiceByIdInDomain, AllPartNumbers, ActiveReceivedOrders, GetReceivedOrder, ReceivingBatchesQuery (+ AllSensorDashboards/CurrentUser ya por autopilot).

**2. Fix CRÍTICO — precio default tocado sin querer (v1.5.29).** Con `Precio default = V` (valor por defecto de la plantilla, columna M, que "Limpiar Datos" pone en V), una carga de SOLO specs re-designaba el precio default de 447 PNs al más reciente (`SetPartNumberPricesAsDefaultPrice` + unset del anterior), sin que el operador cargara ningún precio. **Fix:** el `needsRead` de default-price en SOLO_PN ahora exige `part.precio != null` — sin precio en la fila, NO se toca el default. Test 4/4. Operador: no revertir los 447 ya cambiados (el más reciente es aceptable).

**3. Robustez B+C (v1.5.29).** (B) `steelhead-api.js` detecta `"Must provide a query string"`/`PersistedQueryNotFound` → marca `err.persistedQueryRotated`, lleva `window.__saRotatedOps` y avisa UNA vez por op (`🔴 HASH ROTADO: "X"…`) en vez de cientos de WARNs mudos. (C) `showResult` pinta un banner rojo si hubo rotación (título "⚠️ Detenido por HASH ROTADO") y agrega "PNs modificados: X / Y ⚠️" (= SavePartNumber OK real, no el "OK" del panel que sumaba desarchivados).

**4. Mejoras — fetch dirigido + cliente/etiquetas (v1.5.30).** (M1) `fetchPNsByIdSh(idShSet)`: `GetPartNumber(id)` por cada Id SH único (runPool cap 8 + `periodicDrain` + `extractPNShape` slim) → Map id→shape, en `classifyPNs` antes de elegir modo. Reemplaza el hack de prefetch-global-con-retención; `classifyPNsMassive` ya NO escanea el dominio si `customerIds` vacío (100% Id SH). O(N idSh) vs O(dominio). CSVs SIN idSh: `idShNodes` vacío + early-return → comportamiento idéntico. (M2) `extractPNShape` captura `customerName`; `buildClassifiedRow` (idsh-direct) propaga `nodeCustomerName`+`nodeLabelObjs`; el preview muestra el **cliente real** y una columna **Etiquetas** con chips del color real de SH (`textContent`+color validado a hex, sin XSS). **Pendiente: validación en vivo del operador.**

## Fix 2026-07-02 — Macro `RefrescarListas` (Module2 v14): dejar de pedir "conceder acceso" a cada catálogo viejo en Mac

**Síntoma:** en Excel **para Mac**, al correr "Refrescar Listas" para importar el catálogo (`Catalogos_Steelhead_*.xlsx`), el sandbox pedía **conceder acceso archivo por archivo** a cada catálogo acumulado en Descargas, aunque no fuera el último (el que se quiere importar). Muy molesto; no pasa en Windows.

**Causa raíz:** `BuscarMasReciente` (Module2) recorría TODOS los `Catalogos_Steelhead_*.xlsx` de la carpeta y llamaba `FileDateTime(fullPath)` sobre cada uno para hallar el más nuevo por mtime. En el sandbox de Excel para Mac, leer la metadata (`FileDateTime`) de un archivo NO autorizado dispara el diálogo "conceder acceso" **por cada archivo**. N catálogos viejos → N diálogos. (Windows no sandboxea `FileDateTime`.)

**Fix (Module2 v14 · `vbas/Module2.txt`):** elegir el más reciente **solo por el nombre**, sin tocar disco. La extensión nombra los catálogos con fecha ISO — `Catalogos_Steelhead_YYYY-MM-DD.xlsx` (`catalog-fetcher.js:654`, `new Date().toISOString().slice(0,10)`) — que es ordenable como texto. `Dir()` solo lista nombres (no abre archivos), así el ÚNICO archivo que se toca —y para el que Mac pide acceso— es el ganador, hasta `Workbooks.Open`. Cambios:
- `BuscarMasReciente`: sin `FileDateTime`; compara una clave derivada del nombre.
- `ClaveOrdenCatalogo` (helper nuevo): `fecha ISO + contador` → `"2026-07-02|003"`. Maneja el sufijo ` (N)` de Chrome (varios el mismo día) eligiendo el N más alto (a 3 dígitos). Devuelve `""` si el nombre no calza el patrón (se ignora).
- `NombreBase` (helper nuevo): reemplaza `Dir(found)` del diálogo "¿Usar este archivo?" (que también tocaba el archivo antes de tiempo) por extracción de basename con puro string.
- `GrantAccessToMultipleFiles` NO se usa a propósito: **no habilita `Open`** en este Excel para Mac (nota en Module1, ExportarCSV v15.3).

**Trade-off:** ahora "el último" se define por la fecha del NOMBRE, no por mtime. En uso normal (descargas en orden) es idéntico; solo diferiría si se copia/renombra un catálogo viejo a mano — y aun así la fecha del nombre es más fiel a "qué catálogo es".

**Deploy de la plantilla (para que la que se DESCARGA traiga el fix):** la plantilla se sirve desde gh-pages `templates/Plantilla_CargaMasiva_v12.xlsm` (origen `main:remote/templates/`), **NO** desde Downloads. `deploy.sh` y el hook `pre-push` **solo** manejan `config.json` + `scripts/**.js`; los `.xlsm` de `templates/` se deployan **manual** en gh-pages, en el **mismo commit** que el bump de `config.version` (el hook exige que la version suba en cada push a gh-pages). El VBA del maestro se actualizó **trasplantando el `xl/vbaProject.bin`** (el `.xlsm` es un ZIP) desde la copia de trabajo ya corregida en Downloads: seguro porque `olevba -c` confirmó que el ÚNICO módulo que difería entre esa copia y el maestro era Module2 (v14 vs v13) — las hojas limpias del maestro no se tocan (`tools`→script ad-hoc `transplant.py` en scratchpad, `zipfile` preservando metadata; `unzip -t` + mismas entradas + `olevba` verifican). Config bump 1.7.50 → 1.7.51.

**Pendiente:** la **versión de compatibilidad** (`Plantilla_CargaMasiva_v12_compatibilidad.xlsm`, Excel 2019) tiene el MISMO bug pero quedó en v13 — su `vbaProject.bin` difiere (Module1 compat para Excel 2019), así que **no** se puede trasplantar el bin de la normal; requiere abrirla en Excel y pegar Module2 v14. Run real del fix en la normal: pendiente confirmación del operador (el diálogo debe aparecer **una sola vez**, para el catálogo elegido).

---

## Fix 2026-07-02 — Historial de Cargas vacío ("Sin cargas registradas"): `DataCloneError` silencioso en el guardado a IDB

**Síntoma:** popup → "Historial de Cargas" muestra **"Sin cargas registradas"** desde ~la migración a IDB (varias semanas), con la extensión **1.6.4 ya instalada** (la que lee de IDB). Las cargas se ejecutan bien (crean cotizaciones/PNs); solo el historial no aparece.

**Causa raíz (confirmada por eliminación + empíricamente):** el guardado del historial era el **único** `saIdbSet` que persistía un **objeto crudo** (`saIdbSet('sa_load_history', history)`); TODOS los demás call sites guardan strings vía `JSON.stringify` (resume state L727, índice L681, marker L627). IndexedDB serializa con **structured clone** (estricto), no con JSON. `loadLog` arrastra valores **no clonables** del pipeline (p.ej. `p.products`, nodos del árbol de procesos con funciones/refs) → `store.put` lanza **`DataCloneError` SÍNCRONO** → el `catch` de "Error guardando log" (L6816) lo tragaba → el historial nunca persistía. El `localStorage` viejo usaba `JSON.stringify`, que **omite** funciones/símbolos silenciosamente (tolerante); la migración a structured clone rompió esa tolerancia sin que nadie lo notara (el guardado "parecía" funcionar).

**Evidencia dura (IDB real de `app.gosteelhead.com`, perfil del operador):** `sa_storage/kv` contiene SOLO `sa_bulk_idb_migrated_v1` (el marker); `sa_load_history` = `undefined`; `localStorage.sa_load_history` ausente; `localStorage.sa_last_log` presente (sí hubo corridas). El marker (string ISO) se guardó bien → `saIdbSet` funciona para clonables; solo el objeto rico falla. Confirmación empírica en el navegador: `structuredClone({...fn})` lanza `DataCloneError` mientras `JSON.parse(JSON.stringify(...))` lo tolera. (La "validación 7 corridas" del 2026-06-07 fue en el perfil del dev, con objetos ya-JSON de la migración desde localStorage; ese historial nunca creció porque cada corrida nueva revienta el put sin sobrescribir.)

**Fix:** helper `makeIdbSafe(obj)` = `JSON.parse(JSON.stringify(obj))` con fallback al original; se aplica en el `put` del historial → `saIdbSet('sa_load_history', makeIdbSafe(history))`. Replica la tolerancia del localStorage viejo (strip de no-serializables) preservando todos los datos que lee "Descargar CSV de corrección" (solo primitivos). Solo toca `remote/scripts/bulk-upload.js` (el lector `background.js` 1.6.4 ya está bien → **NO requiere republicar el .zip**). Tests: `tools/test/bulk-upload-history-idb.test.js` (4, incl. reproducción del bug con `structuredClone` como oráculo de IDB.put).

**Qué se requiere para que siga funcionando:** (1) deploy del script a gh-pages (auto-actualiza en Chrome, sin zip); (2) el historial previo del operador **NO es recuperable** (nunca se guardó) — arranca de cero tras el fix; (3) si el historial se usa en **Safari/iPad**, propagar el fix al `safari/extension/main-bundle.js` (skill `safari-bundle-sync`). **Pendiente:** validación en vivo — la próxima corrida real del operador debe aparecer en "Historial de Cargas".

**Deuda de test descubierta (separada, NO tocada aquí):** `node --test tools/test/*.test.js` da **54 fallos pre-existentes** — el harness `loadHelpers` de `bulk-upload-helpers.test.js` (y otros) solo carga `bulk-upload.js`, pero los helpers `classifyOnePN/rankCandidates/chunkParts/makeChunkQuoteName/...` se movieron a `bulk-upload-classify.js`/`-parse.js`/`-build.js` en F1 → salen `undefined` en `__helpers`. **No es bug de producción** (en el navegador cargan en orden vía `config.scripts`); es el harness que quedó desactualizado tras F1. Arreglar aparte: cargar los módulos hermanos en el sandbox del harness antes de `bulk-upload.js`.

---

## Refactor completo (en curso) — F1 (config 1.6.40, 2026-06-06) — Módulos puros + golden tests

**Spec/plan del refactor:** [`docs/superpowers/specs/2026-06-06-bulk-upload-refactor-design.md`](../superpowers/specs/2026-06-06-bulk-upload-refactor-design.md) · [`docs/superpowers/plans/2026-06-06-bulk-upload-refactor-F1.md`](../superpowers/plans/2026-06-06-bulk-upload-refactor-F1.md)

Refactor en 5 fases (F1 extracción/tests · F2 memory+storage · F3 UI panel único + 2 barras · F4 pipeline consolidado worker per-PN · F5 intención + fast-path SOLO_PRECIO).

### Cierre de sesión 2026-06-07 — estado de deploys + fix del `.zip`

**LIVE en gh-pages:** config `version` 1.6.47 + `extensionVersion` 1.6.4. `steelhead-automator.zip` republicado con `manifest.json` **1.6.4** y `background.js` async (IndexedDB) — verificado descargando el link real (64779 bytes, `indexedDB.open('sa_storage')` presente).

**⚠️ Gotcha de deploy de extensión (causa del "el zip baja 1.6.3"):** bumpear `config.extensionVersion` **NO basta**. Chrome lee la versión de `extension/manifest.json`, no de `config.json`. En el primer deploy se subió `config.extensionVersion` a 1.6.4 y se empaquetó el `background.js` nuevo, pero **`extension/manifest.json` quedó en 1.6.3** → el `.zip` mostraba 1.6.3 aunque traía el código nuevo. **Regla:** al republicar el `.zip`, bumpear SIEMPRE `extension/manifest.json` Y `config.extensionVersion` juntos, y **verificar el manifest DENTRO del zip servido** (`curl <extensionZipUrl> -o z.zip && unzip -p z.zip manifest.json | grep version`), no solo el tamaño en bytes. Commit del fix: `fix(extension): bump manifest 1.6.3 -> 1.6.4`. De paso se borraron 2 zips legacy sin referencias (`SHAutomator260330.zip`, `extension.zip`, ambos 1.6.3).

**El usuario debe:** recargar la extensión instalada con el `.zip` 1.6.4 (chrome://extensions → quitar la vieja → cargar la nueva descomprimida) para que `background.js` async tome efecto. Hasta entonces, "Ver historial"/"Descargar CSV" del popup leen del background viejo (localStorage).

**✅ VALIDADO EN VIVO (2026-06-07):** tras instalar la 1.6.4, snippet de DevTools en la tab de Steelhead imprimió `IndexedDB → 7 corridas` + `localStorage → vacío (✅ migrado)`. Confirma: datos en IDB (`sa_storage`/`kv`/`sa_load_history`), migración one-shot corrió y limpió localStorage. **Gotcha detectado en el proceso:** había un `steelhead-automator.zip` viejo (1.6.2, sin IndexedDB) suelto en la raíz del repo; recargar desde ESE archivo instalaba la versión vieja. Se borró del disco y se sacó del versionado de main — el único `.zip` válido vive en gh-pages (el del link `extensionZipUrl`).

**Pendientes NO bloqueantes (próxima semana):** validación de corrida real F4 (`⏱️ Tiempos por fase` via `dumpPhaseTimings`, confirmar AddParams/SaveQuoteLines/isDefault end-to-end) · decisión fast-path SOLO_PRECIO (F5 ya clasifica + badge; falta el atajo real) · restyle F3 a panel anclado a la derecha · `precioAnterior` real para delta en `Detalle` de ControlCambios.

**F1 — refactor estructural sin cambio de comportamiento (deployado, validado por usuario "se ve igual"):**
- Extraídas las funciones PURAS a módulos testeables (`node --test`):
  - `bulk-upload-parse.js` — `toBool/isDash/resolveStr/resolveNum/cell/cellNum/parseCSV/buildDimensions` + constantes (`PRICE_UNIT_MAP`, `PREDICTIVE_MATERIALS`, `HEADER_KEYS`).
  - `bulk-upload-classify.js` — 15 funciones (equivalencias, matching IBMS/composite/near, dedup, chunking), copia byte-fiel de L6525-6984. Dep externa: `window.SteelheadBulkCC`.
- `bulk-upload.js` consume vía destructuring con nombres idénticos (0 call sites tocados); −510 líneas. `resolveUnitId`/`parseRows` NO extraídos (closure).
- **42 golden tests** congelan invariantes blank/dash/data (#1), equivalencias de metales, blank-acabados (#7), fix homónimos 1.4.28.
- `config.json`: parse+classify agregados al array `scripts` (carga-masiva + global) ANTES de `bulk-upload.js`; version 1.6.40.
- `tools/steelhead_probe.py` — lecturas no destructivas vía SteelheadClient de Reportes SH + hashes de config. **Shapes confirmados:** FK escalares (`customerId`, `defaultProcessNodeId`, `geometryTypeId`, `partNumberGroupId`) **no se piden** en GetPartNumber — solo relacionales (`customerByCustomerId.id`); el FK-fallback es la única fuente. Detail completo de 1 PN ≈ **14.8 MB** → valida el seed slim para F4.

**Observaciones de UI del usuario (capturadas para F3):**
- Siguen 3 capas que se traslapan: menú del Automator (arriba-der) + preview grande ("v10 — COTIZACIÓN + NP") + modal `confirmUnresolvedProcesses` (overlay aparte). F3 las unifica en panel derecho expandible + confirmaciones internas + 2 barras.
- El menú mezcla **"Descargar Plantilla + Catálogos"** y **"Actualizar Catálogos"** (solapados); la plantilla Excel es setup, no operación. **Decisión usuario: quitar "Descargar Plantilla" del menú de operación en F3.**

**F2 — memory hardening compartido + robustez (config 1.6.41, 2026-06-06, deployado; validación de usuario pendiente):**
- Adoptado `host-cleanup-shared.js` (en el array `scripts` de carga-masiva + global, antes de `bulk-upload.js`). `stopDatadogSessionReplay` delega a `window.SteelheadHostCleanup` (DRY; mismos latches `__sa_dd_stopped` que el inline, que queda como `_inlineStopDatadog` fallback de transición). Verificado: carga con y sin host-cleanup.
- **`makePeriodicDrain(50)`** ahora SÍ drena el Apollo cache del host en el `finally` del `enrichWorker` (antes ese pool no drenaba → crecimiento sin tope en corridas largas).
- **jitter ±25%** en `withRetry` (anti thundering-herd de los 8 workers concurrentes).
- **`AbortController`** por llamada en `steelhead-api.js` `query()` (default 90s configurable vía `config.steelhead.fetchTimeoutMs`; libera el slot del runPool cuando SH cuelga; `AbortError`→'timeout' retryable). Default generoso porque steelhead-api es compartido por 25 usos.
- Fix tooltip del chip "validada": dice IndexedDB (no localStorage; el resume migró en 1.4.27).
- **Correcciones de mapeo:** `clearDefaultProcess` NO es flag muerto (lo lee el builder en L4607/4741/5396) — no se tocó.
- **✅ HECHO (config 1.6.47 + ext 1.6.4, deploy fin de semana):** `sa_load_history` → IndexedDB. Lo lee `extension/background.js` (`view-load-history`, `download-load-csv` vía `executeScript` world MAIN en la tab). `bulk-upload.js` escribe `saIdbSet` + migración localStorage→IDB + expone `getLoadHistory()`; `background.js` lee IDB (`indexedDB.open('sa_storage')`, store `kv`) async con fallback localStorage. Requirió republicar el `.zip`.

**F4 — velocidad (config 1.6.43/1.6.44, 2026-06-06, deployado; validación de corrida real pendiente):**
- ✅ **AddParams batch** (N→1 por PN) + **SaveQuoteLines batch** (N→1 por cotización), ambos con fallback per-item (peor caso = comportamiento actual). Velocidad real en specs y COTI.
- ✅ **Fix bug `isDefault`** (STEP 8): leía `p.isDefault` (siempre undefined; el campo real es `isDefaultPartNumberPrice`, verificado contra shape de SH) → el unset-default nunca corría; un PN podía quedar con 2 defaults. Corregido.
- ✅ **Instrumentación de tiempos por fase** (`dumpPhaseTimings`) — para medir qué fase domina con datos.
- ❌ **Consolidación `GetPartNumber` 4→1: NO viable** (análisis adversarial). Los re-fetches son NECESARIOS — leen datos post-mutación que toda la serie 1.5.x garantiza frescos; consolidarlos reintroduciría bugs. Solo CS4/CS5 (delete-racks/prices) consolidables y marginales. Análisis: `docs/superpowers/specs/2026-06-06-bulk-upload-F4-getpn-consolidation-analysis.json`.
- ✅ **Scan acotado YA existía**: `classifyPNs` usa on-demand para ≤1000 filas, massive solo para >1000. Las corridas chicas NO escanean 50k. El mapeo inicial se equivocó.
- 🟡 **Skip 8 (`partNumberLocations`)**: bug real en código (`[]` borraría con REPLACE) pero **INOFENSIVO en TLC** — `SearchLocationsOnPath` confirma **0 ubicaciones de PN en el dominio** (TLC no usa partNumberLocations). NO se corrigió: corregir requiere el shape de un location node + validar contra un PN con ubicaciones (no existe en TLC). Corregir a ciegas sería más riesgoso que el bug inofensivo. **Plan:** preserve-on-missing (como dims) cuando un dominio use ubicaciones, validando contra un PN real.
- ✅ **Sandbox "Pruebas Claude" (id 3671383) archivado** tras las validaciones de escritura. Writer reutilizable: `tools/sandbox_pn.py` (create/get/save/archive con guarda de nombre).
- **Pendiente:** validación de F4 con corrida real (la "prueba" que el usuario difirió) — confirmar AddParams/SaveQuoteLines/isDefault end-to-end + revisar el desglose `dumpPhaseTimings`.

## 1.5.20 (config 1.6.38, 2026-06-05) — Actualización de precios: matching con acabados vacíos + footprint ControlCambios + inputSchemaId dinámico

**Objetivo:** habilitar bulk-upload para **actualizar precios** de PNs existentes,
donde el upload trae NP + precio pero **sin etiquetas de acabado** (el operador no
las conoce ni le importan para un cambio de precio). Validado en piloto ("ya quedó",
confirmado por el usuario). Deployado a gh-pages.

### Feature A — *blank-acabados fallback* en `classifyOnePN`
Cuando el upload **no trae acabados** (`csvAcabados === ''`, ya con las labels de
planta `nonFinishLabelNames` filtradas) y hay ≥1 PN activo con ese nombre+cliente:
- **1 candidato** → MODIFICA ese PN, **corre directo** (`autoDecided: true` →
  `userDecided: true`), badge **"auto: NP más reciente"** en el preview.
- **2+ candidatos** → preselecciona el **más reciente** (id más alto) en el dropdown
  de Pase 3, exige confirmar.
- `confidence` nuevo: `'name+blank-csv-recent'`. La rama va **ANTES** de
  `labelsMatchFull`/`blankCandidate` (fix del review — ver abajo) para cubrir también
  el caso común CSV-sin-acabados + candidato-sin-acabados.
- **Regla preservada:** solo dispara con acabados vacíos. Si el upload trae acabados
  **no vacíos** que difieren → sigue el comportamiento previo (default `NEW`).
- "Más reciente" = id más alto (los ids de Steelhead son autoincrement). El helper
  `decideBlankAcabados` ignora el ranking por metal/acabados a propósito: sin acabados
  que comparar, el criterio es recencia, según pidió el usuario.

### Feature B — footprint en `customInputs.ControlCambios`
El usuario creó del lado de Steelhead el **schema `inputSchemaId 3932`** (dominio TLC),
que ya incluye el campo **`ControlCambios`** (array de "Evento" con
`{ Fecha, Usuario, Accion, Detalle, Version }`, `ui:order` al final de la ficha). Como
vive **dentro del schema**, la UI de Steelhead lo preserva y renderiza — **sin la
fragilidad** de un key fuera de schema.
- Se appendea **una entrada por corrida por PN, solo si hubo cambio real**
  (`computeAccion` devuelve vacío → no se loguea).
- `Accion` (cortos, combinables por coma): `ALTA` (PN nuevo) · `PRECIO` (trae precio) ·
  `ENRIQUECIMIENTO` (specs/dims/labels/metal/proceso).
- `Usuario` = `CurrentUserDetails` → `currentSession.userByUserId.name` (1 llamada
  cacheada al inicio de `execute`; fallback `"(desconocido)"`, no aborta).
- `Version` = **versión del config** (`window.REMOTE_CONFIG.version`, NO `bulkCfg()`
  que no la expone — ver fix del review).
- `Fecha` = `new Date().toISOString()`. `Detalle` = best-effort; **`precioAnterior`
  queda `null`** por ahora (muestra solo el precio nuevo, no el delta — mejora futura).
- **Enganche:** en `enrichWorker`, justo **antes de `const pnInput`** (Call B), donde
  `specsToApplyFiltered`/`dims`/`labelIdsToSend`/`pnProcessId` ya están resueltos.
  `mergedCI` pasó de `const` a `let` (se inicializa a `{}` si era null) y se modifica
  por referencia → Call B lo lleva. Append no-destructivo (preserva historial previo).
  Sin cap de entradas (audit completo).

### Fix clave — `inputSchemaId` dinámico (deja de degradar PNs a 3456)
bulk-upload hardcodeaba `DOMAIN.inputSchemaId_PN` (= 3456, obsoleto) en los 5 payloads
de `SavePartNumber`. Eso degradaba cualquier PN tocado al schema viejo y tiraba
`ControlCambios` fuera de schema. **Fix:** capturar `latestSchema.id` (que bulk-upload
ya calculaba en el bloque de enums) en `runtimeInputSchemaId` y usarlo en STEP 2a,
STEP 5, Call A, Call B y cleanup.
- **A prueba de futuro y multi-dominio:** cada dominio devuelve su schema vigente vía
  `GetPartNumbersInputSchema` (TLC → 3932, MTY → el suyo). No hay que parametrizar
  config por dominio.
- **Migra PNs viejos 3456 → 3932 al tocarlos** (3932 es superset: mismos campos +
  ControlCambios). El backend tolera `required: ['BaseMetal']` (validación solo UI/RJSF).
- Fallback `config.inputSchemaId_PN` bumpeado **3456 → 3932** por si la query falla.

### Módulo nuevo `bulk-upload-cc.js`
Helpers puros con dual-export (`window.SteelheadBulkCC` + `module.exports`), cargado
ANTES de `bulk-upload.js` en el array `scripts` (applet `carga-masiva` + top-level):
`pickMostRecent`, `decideBlankAcabados`, `computeAccion`, `buildDetalle`,
`buildControlCambiosEntry`, `appendControlCambios`. Tests con `node --test` en
`tools/test_bulk_upload_cc.js` (**19 pasando**). Degradación segura: si el módulo no
cargó, Feature A cae al comportamiento previo y Feature B no escribe (sin romper).

### Correcciones del code-review (3 reales, pre-deploy)
1. **Versión del footprint equivocada:** `bulkCfg()` arma su objeto desde
   `steelhead.domain.bulkUpload` y **no propaga `.version`** → estampaba el `VERSION`
   del applet (`1.5.20`) en vez del config. Fix: `window.REMOTE_CONFIG.version`.
2. **Gap en Feature A:** la rama estaba *después* de `labelsMatchFull`, así que el caso
   común (CSV sin acabados + candidato sin acabados, `''==='' → true`) caía en
   `name+labels-match` **sin auto-decidir**. Se movió antes de `labelsMatchFull`.
3. **`dedupModifyTargets`:** se agregó `'name+blank-csv-recent'` al `confRank` (rank 3).
   Hardening: `buildDetalle` no produce `"undefined USD"` si falta precio;
   `decideBlankAcabados` null-safe si el candidato no tiene id.

### Gotcha de coordinación — colisión de versión con el archiver
La sesión paralela del `archiver` ya había publicado **`1.6.37`** en gh-pages. Esta
sesión también había bumpeado a `1.6.37` independientemente → se subió a **`1.6.38`**
para que el cache-bust dispare el reload. Lección: **una sola sesión bumpea config y
deploya a gh-pages por vez** (regla del CLAUDE.md). Deploy hecho vía **worktree
temporal de gh-pages** (`/tmp/sa-ghpages`) para no tocar el WIP de `main`; solo se
escribieron `bulk-upload-cc.js` (nuevo), `bulk-upload.js` y `config.json` —
`scripts/archiver.js` quedó intacto. Byte-exact verificado con `tools/check-deploy.sh`.

### Pendientes derivados
- `precioAnterior` real en el `Detalle` (leerlo de `existingPnNode.partNumberPricesByPartNumberId`) para mostrar el delta `ant → nvo`.
- Evaluar cap de entradas de `ControlCambios` si crece de más en PNs muy tocados.

## 1.5.19 (config 1.6.36, 2026-06-04) — Fix: la LÍNEA de cotización nacía sin proceso (distinto del default del PN)

### Síntoma (incidente real)
Cargas **Tipsa Anual** (cliente TROQUELADOS/TIPSA): cotización **233** "Tipsa
Anual 5/26" (22 PNs) y **235** "Tipsa Anual 8/26" (5 PNs). El operador notó que
"ningún NP trae proceso" en las cotizaciones. Verificado con la API:
- El **proceso default del PN** (`defaultProcessNodeId`) quedó **INTACTO** en
  los 39 PNs (snapshot pre-carga == estado actual, vía FK). El fix 1.5.18 cumplió.
- El **proceso de la LÍNEA de cotización** (`partNumberPrice.processNodeByProcessId`)
  quedó **VACÍO** en las 27 líneas. El 92% del dominio sí lo trae (Schneider
  250/250); Tipsa 0%. Las cotizaciones son **nuevas** (rev 1) → nacieron sin él,
  no hubo borrado.

### Root cause (dos "procesos" distintos + un agujero)
El "proceso" vive en dos campos: (a) `defaultProcessNodeId` del PN y (b)
`processId` de cada línea de precio (`partNumberPrice`). La línea de cotización
se arma en STEP 4 (`SaveManyPartNumberPrices`) con `processId: part.processId`
(líneas ~4604 y ~4737) **sin** el FK-fallback que 1.5.18 puso en Call B (~5392).

`part.processId` llegó **null/undefined** en esas corridas. Escenario consistente
con toda la evidencia (MODIFY con default intacto + línea vacía + NEW `145608`
sin proceso): **processCache miss** — el CSV traía nombre de proceso pero
`processCache.get(nombre)` devolvió `undefined`; como `procesoOverride` no estaba
vacío, el part **no** entró al path "heredar" del post-process (que sí habría
usado `existingProcessId`). Resultado: la línea recibió `undefined`, mientras
Call B salvó el default del PN heredando por FK (`part.processId == null`).

Confirmado empíricamente:
- Captura DevTools real de `SaveManyPartNumberPrices`: `processId` ES el campo
  correcto y SH lo persiste (HTTP 200) → la mutación no es el problema.
- `GetQuote_v71` (hash vigente `41d76b06…`) usa variables `{idInDomain,
  revisionNumber}` (NO `quoteId`) — anotado para no perder tiempo de nuevo.
- `main` == `gh-pages` (1.5.18) durante las corridas → no fue versión vieja.

### Fix
Red de seguridad en los **dos** puntos de creación del `partNumberPrice`
(cotización ~4604 y SOLO_PN ~4737):
```js
processId: part.clearDefaultProcess ? null : (part.processId ?? status.existingProcessId ?? null),
```
Si `part.processId` quedó null/undefined (processCache miss, heredar, etc.) y NO
es borrado explícito (`-`/clearDefaultProcess), la línea cae al proceso default
ACTUAL del PN (`existingProcessId`, poblado vía FK en `extractPNShape:1629`). El
dash sigue borrando. No cambia el caso normal (proceso resuelto).

### Recuperación de las cotizaciones 233/235 — NO ejecutada (decisión)
Las 27 líneas están ligadas a una OV recibida (`receivedOrderPartTransforms=1`).
Revertir/editar por API arriesga romper ese vínculo; el impacto de la cotización
sin proceso es bajo. Decisión del usuario: **dejarlas así**. Si se recuperan a
futuro: editar el proceso de la línea desde la UI (update in-place que preserva
id+orden), o capturar ese shape de update antes de tocar por API.

### Plan de validación pendiente
- Carga piloto con PN existente cuyo default ≠ vacío, forzando que la línea de
  cotización quede con el proceso default (verificar `processNodeByProcessId`
  poblado post-carga).
- Verificar que `-` (dash) deja la línea sin proceso (clearDefaultProcess).
- Investigar la causa raíz del processCache miss (¿resume sin reconstruir cache?,
  ¿normalización de nombres?) — la red de seguridad cubre el síntoma; la causa
  del miss sigue abierta.

### Deploy
- `bulk-upload.js`: `VERSION = '1.5.19'`.
- `config.json`: `1.6.35` → `1.6.36`, `lastUpdated` 2026-06-04T20:30.

---

## 1.5.18 (config 1.6.30, 2026-06-03) — Fix CRÍTICO: "Preservar proceso" borraba el proceso del PN existente

### Síntoma (incidente real)
Carga **Tipsa Anual** (cliente TROQUELADOS INDUSTRIALES DE PRECISION, 17 PNs
existentes, COTIZACIÓN+NP). La columna Proceso del Excel resolvió a
`"Combinación no existente"` en los 17. El operador eligió **"Preservar"** en
el modal de procesos no resueltos (1.5.12) — esperando heredar el proceso
actual. Resultado: los **17 PNs perdieron `defaultProcessNodeId` (→ null)**.
Verificado con snapshot pre-carga: solo el proceso se borró; todo lo demás
(customInputs, labels, specs, dims, UCs, predictivos, geometría) quedó intacto.

### Root cause
Cadena de 3 eslabones:
1. `bulk-upload.js:3579` colapsa **"vacío" (heredar)** y **"-" (borrar)** al mismo
   `p.processId = null`. El dash además marca `clearDefaultProcess=true` (3842);
   el vacío no.
2. El post-process (≈3847-3860) resuelve el "vacío" heredando
   `st.existingProcessId`. Pero `existingProcessId` se lee del **scalar
   `defaultProcessNodeId`** (líneas 1915/1956/2752/6815), que el persisted query
   devuelve **siempre null** (mismo bug del scalar que motivó el FK-fallback de
   1.5.16). Con `existingProcessId` null, el post-process cae a 3854-3857 →
   `p.processId = null` (sin `clearDefaultProcess`).
3. **Call B** (`defaultProcessNodeId: pnProcessId`, 5386) — `pnProcessId =
   part.processId` (null) — lo mandaba como null. SavePartNumber (REPLACE)
   **borraba** el proceso. (Call A en 5225 sí tenía FK-fallback y lo preservaba,
   pero Call B lo pisaba después.)

De todos los `defaultProcessNodeId:` en inputs, **solo Call B carecía** del
FK-fallback que 1.5.16 puso en 4317/5225/5866.

### Fix
`bulk-upload.js` Call B (≈5377): distinguir heredar de borrar usando
`clearDefaultProcess`, y para heredar caer al proceso ACTUAL vía FK relacional
(`existingPnNode`/`pn`, que `GetPartNumber` sí trae bien):
```js
const pnProcessId = (part.processId == null && !part.clearDefaultProcess)
  ? ((existingPnNode?.processNodeByDefaultProcessNodeId?.id ?? existingPnNode?.defaultProcessNodeId)
     ?? (pn.processNodeByDefaultProcessNodeId?.id ?? pn.defaultProcessNodeId) ?? null)
  : part.processId;
```
Más ajuste de log en 3854-3857 (ya no warnea "queda sin proceso"; indica que
Call B heredará vía FK). El `-` (dash) sigue borrando (clearDefaultProcess=true).

### Recuperación del incidente
Los 17 PNs se restauraron desde `snapshot_TROQUELADOS_2026-06-03.json` (backup
pre-carga) con `SavePartNumber` preservando todo + `defaultProcessNodeId`
original. 17/17 OK, 0 daño colateral (script `tools/restore_process.py` patrón
cleanupInput STEP 6b).

### Plan de validación pendiente
- Re-correr una carga con proceso vacío/"Combinación no existente" + "Preservar"
  sobre un PN existente con proceso → verificar que el proceso se conserva.
- Verificar que `-` (dash) sigue borrando el proceso correctamente.

### Deploy
- `bulk-upload.js`: `VERSION = '1.5.18'`.
- `config.json`: `1.6.29` → `1.6.30`, `lastUpdated` 2026-06-03T20:30.

---

## 1.5.17 (config 1.6.29, 2026-06-03) — Fix latentes STEP 6b: preserve `optInOuts` + `inventoryItemInput` (UCs)

### Contexto
Cierre de los "pendientes derivados" documentados en 1.5.15 (líneas 244-247).
El cleanup de specFieldParams duplicados (regla 1.4.38) dispara un
`SavePartNumber` cuando `idsToArchive.length > 0` — frecuente en re-cargas
de PNs que ya tienen params. Ese payload preservaba labels/dims/customInputs/
proceso/geometría (fixes 1.5.6/1.5.15/1.5.16) pero **seguía mandando
`optInOuts: []` e `inventoryItemInput: null` literales** → SH (REPLACE-
semantics) borraba la validación 1er artículo y las unit conversions que
Call B acababa de aplicar. No se había visto en pilotos previos porque
los CSV de prueba no traían UCs ni validación 1er artículo activa.

### Diagnóstico de los 3 latentes (1.5.15 los marcó como pendientes)
| Campo (cleanupInput) | Semántica SH | ¿Borra? | Acción 1.5.17 |
|---|---|---|---|
| `inventoryItemInput: null` | REPLACE (null = borrar inventoryItem, ver 1.5.13) | **SÍ** borra UCs | **Corregido**: reconstruir desde `pnNode` |
| `optInOuts: []` | REPLACE (ver 1.5.13) | **SÍ** borra validación 1er art. | **Corregido**: reconstruir desde `pnNode` |
| `inventoryPredictedUsages: []` | **additive/create-only** | **NO** borra | **Dejado en `[]` a propósito** |

**Por qué `inventoryPredictedUsages` NO es bug** (corrige la suposición de 1.5.15):
el campo solo CREA predictivos nuevos — Call B (línea ~5394) filtra los
existentes "para no crear duplicados", y los updates/archives de predictivos
los maneja STEP 6a vía `ChangePredictedInventoryUsagesWithRecipeNodeCascade`
(endpoint dedicado). La post-mortem v104 (16k PNs) reportó blanqueo de
`customInputs` pero **nunca de predictivos**. Reconstruir el campo aquí
los **DUPLICARÍA** — por eso se deja en `[]`.

### Fix
`bulk-upload.js` STEP 6b (antes de `const cleanupInput`): se reconstruyen
`cleanupOptInOuts` y `cleanupInventoryItemInput` desde el `pnNode` fresco
(post Call A/B/6a), con el mismo patrón preserve-on-missing de Call B
(líneas ~5334 y ~5354). Verificado que `GetPartNumber` (mismo query que
alimenta tanto `existingPnNode` de Call B como `pnNode` de STEP 6b) trae
`processNodePartNumberOptInoutsByPartNumberId`, `inventoryItemByPartNumberId`,
`inventoryItemUnitConversionsByInventoryItemId`, `materialByMaterialId`,
`sourceMaterialConversionType`.

### Validación 2026-06-03 — ✅ APROBADA (piloto MODIFY, clientes generales)
Piloto SOLO_PN de 5 PNs (3 existentes modificados) sobre clientes generales.
Evidencia (snapshot BEFORE/AFTER vía `GetPartNumber` con el cliente de Reportes SH):
- **Cascade STEP 6a** (primera ejecución real en prod): `73295-023-01`
  Estaño 843→900, `40515-291-01` Zinc 138→100. Replace correcto, **sin
  duplicar** (1 predictivo por PN tras la corrida).
- **Fix 1.5.17 (este)**: STEP 6b disparó en `40515-291-01` y `CEDAR 03`
  (archive 5 params c/u por regla 1.4.38) y las **UCs quedaron 6→6, NO se
  blanquearon**. Sin el fix habrían quedado en `[]`. optInOuts vacíos en los
  3 (nada que preservar, pero el path no rompió).
- Sin duplicación (`0 dup`), customInputs/params intactos, los 2 PNs viejos
  (`#3016998`, `#3027553`) no se tocaron al crear 2 nuevos (acabado distinto).
- `73295-023-01` tuvo HTTP 500 → retry strip1 (sin specs/optIn); se recuperó
  con predictivo/UCs/params correctos.

**Gotcha confirmado — predictivo en `0` vs `-`**: el parser trata un valor
predictivo `0`/`0.0` como "sin valor / no tocar" (lo excluye de
`part.predictiveUsage`), NO como "poner en cero". `CEDAR 03` traía Zinc=0.0
y su predictivo se quedó en 15 (no cambió). Para **anular/borrar** un
predictivo existente hay que usar guión `-` (cascade `toArchive`); un `0`
deja el valor viejo. Comportamiento seguro (no borra), pero hay que saberlo.

**Nota de clasificación**: en ambos pilotos (Schneider y clientes generales)
los existentes salieron `P3` (decisión pendiente). El matcher pre-selecciona
⭐ "Modificar #id" cuando reconoce (mismo metal+labels+proceso) y "crear
nuevo" cuando el acabado difiere — comportamiento correcto, pero implica
revisar/confirmar cada fila P3 antes de ejecutar (en cargas grandes, muchas).

### Deploy
- `bulk-upload.js`: `VERSION = '1.5.17'`.
- `config.json`: `1.6.28` → `1.6.29`, `lastUpdated` 2026-06-03T12:00.

---

## STEP 6a refactor (config 1.6.28, 2026-06-01) — `ChangePredictedInventoryUsagesWithRecipeNodeCascade`

### Contexto
Rotación masiva 2026-06-01 deprecó `UpdateInventoryItemPredictedUsage` y `ArchivePredictedInventoryUsage` (los hashes anteriores devolvían HTTP 400 `"Must provide a query string."`). El reemplazo es **una sola mutación** que consolida los 3 paths previos del STEP 6a:

| Path previo | Caso | Reemplazo en cascade |
|---|---|---|
| `ArchivePredictedInventoryUsage` (pre-update) | unarchive de PIU previamente archivado | `toArchiveAndReplace` con `archiveId` del archivado |
| `UpdateInventoryItemPredictedUsage` batch-20 | update simple de PIU activo | `toArchiveAndReplace` con `archiveId` del PIU vigente |
| `ArchivePredictedInventoryUsage` pool (dash sentinel `—`) | borrar PIU porque el material salió del recipe | `toArchive` con `archiveId` |

### Input shape
```js
{
  input: {
    toCreate: [],                  // no usado por STEP 6a (los creates van en Call B vía SavePartNumberRecipeNode)
    toArchiveAndReplace: [{ archiveId, inventoryItemId, partNumberId, microQuantityPerPart: "<string>" }],
    toArchive: [{ archiveId }],
    cascadePairs: []
  }
}
```

**Gotcha crítico**: `microQuantityPerPart` se serializa como **STRING** (no número), confirmado en sample variables del scan. JS `String(value)` antes de mandar.

### Beneficios
- 1 mutación atómica vs 3 con interleaving frágil
- Sin "batch-20 update + pool concurrent archives" (ambos competían contra mismo PN)
- Chunks de 50 PIUs por call

### Comportamiento preservado
- Fix JJ 1.4.30 (skip-stale-dash si PIU ya está archivado)
- Fix KK 1.4.31 (no re-archivar PIUs ya archivados)
- Fix K1 1.3.3 (numérico-a-numérico solo si difiere)
- Sterlingshield S 2728.8 LTS bug (Plata Fina / Epoxy MT / Epoxica BT / Estaño Puro) — sigue cubierto por toArchiveAndReplace

### Pendiente
**Validación piloto (3-5 PNs con `predictiveUsage` real + 1 PN con dash sentinel `—`)** — la mutación nunca se ha disparado en producción. Antes de bulk run grande, correr piloto y verificar:
- PIU se crea/actualiza correctamente (numérico)
- PIU se archiva correctamente (dash)
- archived PIUs no se duplican

### Archivos tocados
- `remote/scripts/bulk-upload.js` STEP 6a (~líneas 5556-5660): 3-phase block → 2-bucket build + cascade calls
- `remote/config.json` 1.6.27 → **1.6.28**, +1 hash `ChangePredictedInventoryUsagesWithRecipeNodeCascade`, conserva `ArchivePredictedInventoryUsage` para `tools/archive-predictive-dash.js`

## 1.5.16 (2026-05-30) — Fix FK fallback para scalars bugged (`defaultProcessNodeId` / `geometryTypeId` / `customerId` / `partNumberGroupId`)

### Síntoma
Tras 1.5.15 corregir el blanqueo de dims, el piloto v2 (3 PNs Fisher
NUEVOS: `S2J3328A01` / `S18A6432A1` / `SGH14832A2`) mostró que **los
dims SÍ persistieron**, pero `defaultProcessNodeId` quedó null en 3/3
y `geometryTypeId` quedó null en 3/3 al leer con `GetPartNumber` desde
el verify post.

Bandera roja: el panel de SH muestra el proceso aplicado (UI dice
"Proceso: T100 (PUL)-T103 (CRD)-..." con valor) pero `GetPartNumber`
escalar dice `defaultProcessNodeId: null`.

### Root cause real (investigación empírica con `test_direct_save_processgeo.py`)
**Doble bug encadenado**:

1. **El persisted query `GetPartNumber`** (hash
   `60bee2e1bf45e3fba1e763994ab9f2691d7de0f44809434bd1e810b5219436c2`)
   tiene los campos escalares `customerId / defaultProcessNodeId /
   geometryTypeId / partNumberGroupId` siempre `null` en la respuesta,
   pero las relaciones FK sí están pobladas:
   `customerByCustomerId.id`, `processNodeByDefaultProcessNodeId.id`,
   `geometryTypeByGeometryTypeId.id`, `partNumberGroupByPartNumberGroupId.id`.
   Bug del persisted query, no del backend.

2. **bulk-upload leía esos escalares bugged en 4 lugares** y los
   reenviaba a `SavePartNumber`. Como SavePartNumber tiene
   REPLACE-semantics, mandar `defaultProcessNodeId: null` o
   `geometryTypeId: null` desvinculaba esos campos en SH **aun cuando
   Call B sí los aplicó correctamente**.

   El cleanup STEP 6b (regla 1.4.38, líneas 5807-5870) era el culpable
   principal: corre 50ms después de Call B, refetchea el PN, lee
   `pnNode.defaultProcessNodeId` (= null por el bug) y manda
   `SavePartNumber({ defaultProcessNodeId: null, geometryTypeId: null,
   customerId: null, partNumberGroupId: null, ...})` con todo lo demás
   "preservado", borrando los 4 scalars.

   `defaultProcessNodeId` se salvó parcialmente en algunos PNs porque la
   línea 5832 ya tenía fallback a `part.processId` desde el CSV. Pero
   `geometryTypeId` no tenía rescue → se perdió en 3/3.

### Evidencia (test empírico aislado)
`test_direct_save_processgeo.py` sobre PN 3017049 (`S2J3328A01`):
1. `AllProcesses` resuelve el proceso del CSV → `processNodeId=171633`.
2. `GetPartNumber(3017049)` → `defaultProcessNodeId: null` (escalar) pero
   `processNodeByDefaultProcessNodeId.id: null` también (post-piloto)
   y dims=2 activos.
3. `SavePartNumber({ defaultProcessNodeId: 171633, geometryTypeId: 831, customerId: <FK>, ...preserve })`.
4. Re-fetch → SH ahora persiste los 2 campos en la FK (`processNodeByDefaultProcessNodeId.id=171633`).

**Verdict**: SH acepta el payload; el bug está en bulk-upload leyendo
escalares bugged.

### Fix
Patrón aplicado en 7 puntos del archivo: `pnNode.X` → `(pnNode.YByY?.id ?? pnNode.X)` con fallback final al CSV cuando hay valor:

```js
// 1.5.16 — Patrón FK-first:
customerId:           (pnNode.customerByCustomerId?.id           ?? pnNode.customerId)           || part.customerId,
defaultProcessNodeId: (pnNode.processNodeByDefaultProcessNodeId?.id ?? pnNode.defaultProcessNodeId) || part.processId,
geometryTypeId:       (pnNode.geometryTypeByGeometryTypeId?.id    ?? pnNode.geometryTypeId)        || null,
partNumberGroupId:    (pnNode.partNumberGroupByPartNumberGroupId?.id ?? pnNode.partNumberGroupId) || null,
```

Edits aplicados en `bulk-upload.js`:
1. `VERSION` línea 188 → `'1.5.16'`.
2. `enrichWorker` minInput (≈4305-4313) — 4 scalars con FK fallback.
3. Call A `pnGroup` resolution (≈5189-5192) — FK fallback.
4. Call A `identifierInput` (≈5204-5217) — `customerId` / `defaultProcessNodeId` / `geometryTypeId` con FK fallback.
5. Call B `resolvedGeometryTypeId` (≈5288-5300) — FK fallback en ambos paths fallback.
6. Call B `pnInput.customerId` (≈5374-5375) — FK fallback.
7. STEP 6b `cleanupInput` (≈5827-5835) — los 4 scalars con FK fallback. **Era el blanqueador principal**.

### Plan de validación pendiente
- Recargar extensión y re-correr el CSV piloto v2
  (`/Users/oviazcan/Downloads/fisher_pilot_v2_v23.csv`) sobre los 3 PNs
  Fisher (`S2J3328A01` / `S18A6432A1` / `SGH14832A2`).
- Verificar con `verify_pilot_v2.py` (ya actualizado para leer FK relacional):
  - `processNodeByDefaultProcessNodeId.id` poblado en 3/3.
  - `geometryTypeByGeometryTypeId.id == 831` (TLC genérica) en 3/3.
  - `customerByCustomerId.id == 185639` (Fisher) preservado en 3/3.
  - Dims activos (2 o 3) en 3/3.
  - Labels intactos.
  - `customInputs` solo cambios CSV-driven.

### Pendientes derivados
- **Auditar otros applets que usen `GetPartNumber`** y lean
  `defaultProcessNodeId / geometryTypeId / customerId / partNumberGroupId`
  escalares directos: `archiver`, `auditor`, `spec-migrator`. Si alguno
  los reenvía a `SavePartNumber`, tiene el mismo bug latente.
- **Levantar issue a SH backend / persisted queries**: corregir el bug
  del query o regenerar el hash con un query que sí devuelva los
  escalares. Pendiente comunicar a Steelhead.
- Limpiar el cache `existingPnFullCache` se invalida en finally tras
  Call B (línea 5454). Considerar invalidar solo cuando se sepa que el
  PN cambió, no en todos los casos, para reducir re-fetches en STEP 6b.

### Deploy
- `remote/scripts/bulk-upload.js` → 1.5.16
- `remote/config.json` → 1.6.22, lastUpdated `2026-05-30T22:00`
- gh-pages sync byte-exact pendiente

---

## 1.5.15 (2026-05-30) — Fix STEP 6b cleanup: field names para preserve dims

### Síntoma
En el piloto Fisher 2026-05-30 (3 PNs en modo SOLO_PN: `S12B7026A1` /
`S14B8644A1` / `S16A1367A1`), Call A y Call B ambos reportaron éxito
(`SavePartNumber: 3 OK, 0 retry`) y los specs/params se sincronizaron
correctamente, pero el verify post-piloto mostró que los 3 PNs quedaron
sin `partNumberDimensions` (0 dims activos) y sin `defaultProcessNodeId`,
a pesar de que el CSV traía dims completos (L=0.115 / W=0.115 / H=0.017)
y proceso resuelto. `customInputs` sí persistieron (PiezasCarga / Notas
con artefactos `_x000D_` y PN alterno `12B7026X013` aparecieron en SH),
confirmando que SavePartNumber sí ejecutó.

### Root cause
El cleanup de duplicados de `specFieldParams` (regla 1.4.38, líneas
5795-5865) tiene el mismo bug de field names que ya se corrigió en Call B
para 1.5.14, pero el fix no se propagó a este bloque:

```js
// 1.5.10..1.5.14 — INCORRECTO (líneas 5817-5819):
const cleanupExistingDims = (pnNode.partNumberDimensionsByPartNumberId?.nodes || [])
  .filter(d => !d.archivedAt && d.dimensionId && d.unitId != null)
  .map(d => ({ dimensionId: d.dimensionId, microQuantity: d.microQuantity, unitId: d.unitId }));
```

`GetPartNumber` devuelve `geometryTypeDimensionTypeId / dimensionValue /
unitByUnitId.id`. El filter siempre retornaba `[]` → el cleanup mandaba
`partNumberDimensions: []` → SH (REPLACE-semantics) borraba los dims que
Call B acababa de aplicar. El path solo se dispara cuando
`idsToArchive.length > 0` (PNs con specs duplicados por la regla 1.4.38)
— por eso no se vio en piloto SCHNEIDER de 1.5.14 (sin spec params
duplicados) y sí se vio en piloto Fisher (10/5/3 params a archivar por PN).

### Evidencia (panel log piloto Fisher)
```
[SA] Procesos únicos en layout: 2          ← resolver OK, sin modal
[SA] Clasificación: P0=0 P1=3 P2=0 P3=0 NEW=0
[SA] SavePartNumber: 3 OK, 0 retry         ← Call A + Call B OK
[SA] PN "S12B7026A1": archive 10 params (regla 1.4.38)  ← dispara STEP 6b
[SA] PN "S14B8644A1": archive 3 params
[SA] PN "S16A1367A1": archive 5 params
[SA] Spec params sync: 13 params agregados
[SA] Cleanup duplicados (1.4.9): 18 params null archivados en 3 PNs
```

Verify post-piloto live: `defaultProcessNodeId=null`, `optInOuts=[]`,
`partNumberDimensions=0 active`, `customInputs` cambiados.

### Fix
`bulk-upload.js:5807-5822`:

```js
// 1.5.15 — CORRECTO:
const cleanupExistingDims = (pnNode.partNumberDimensionsByPartNumberId?.nodes || [])
  .filter(d => !d.archivedAt && d.geometryTypeDimensionTypeId && (d.unitByUnitId?.id ?? d.unitId) != null)
  .map(d => ({
    geometryTypeDimensionTypeId: d.geometryTypeDimensionTypeId,
    dimensionValue: d.dimensionValue,
    unitId: d.unitByUnitId?.id ?? d.unitId,
  }));
```

Mismo patrón que 1.5.14 aplicó en Call B.

### Por qué `defaultProcessNodeId` también quedó null
La línea 5829 hace `pnNode.defaultProcessNodeId || part.processId`. Como
el cache (`existingPnFullCache`) se invalida en finally tras Call B
(línea 5454), el `pnNode` en STEP 6b se trae fresco vía `GetPartNumber`
con el estado POST-Call B. Hipótesis: SH desacopla `defaultProcessNodeId`
cuando se hace REPLACE con `partNumberDimensions:[]` (side-effect
servidor), o el pnNode no trajo el processId aplicado por alguna razón
de timing. Pendiente verificar post-fix: si tras corregir dims el
processId también persiste, queda resuelto. Si no, será otra investigación.

### Plan de validación pendiente
- Restore manual de los 3 PNs Fisher del piloto desde snapshot pre
  (`/tmp/fisher_snapshot_pre_2026-05-30.json`) para volverlos al estado
  pre-1.5.14: sin Proceso, sin Val1, sin dims, pero con CI original.
- Re-correr el mismo CSV piloto (`/Users/oviazcan/Downloads/fisher_pilot_v23.csv`)
  con 1.5.15.
- Verificar que post-corrida los 3 PNs queden con: dims poblados (L/W/H),
  defaultProcessNodeId set, optInOuts vacíos (CSV='F'), spec params
  archivados según regla 1.4.38, customInputs preservados.

### Pendientes derivados
- Latent bug en línea 5840: `optInOuts: []` también es REPLACE. Si Call B
  aplicó optInOuts (CSV='T'), este cleanup los borra. En piloto Fisher
  no afectó porque CSV='F' → []==[]. Aplicar preserve-from-pnNode en
  próximo fix.
- Latent bug en línea 5834: `inventoryItemInput: null` — si Call B aplicó
  UCs, este cleanup las borra. Mismo tratamiento.
- Línea 5841: `inventoryPredictedUsages: []` — idem.
- Auditar si más bloques con `SavePartNumber` usan los field names viejos
  (búsqueda `dimensionId` literal en bulk-upload.js).

### Deploy
- `remote/config.json`: version 1.6.20 → 1.6.21, `lastUpdated` 2026-05-30T19:00.
- `bulk-upload.js`: `VERSION = '1.5.15'`.
- Commit main: `16fd33e`. Commit gh-pages: `8927852`. Verificado byte-exact.

## 1.5.14 (2026-05-30) — Fix Bug 7 v2: field names correctos en preserve dims

### Síntoma
En el piloto de 1.5.13 (3 PNs SCHNEIDER, modo COTIZACIÓN+NP, solo Precio+
Unidad), el PN `7348022125` (idsh 2843345) perdió sus 3
`partNumberDimensions` (3 → 0). Los otros 2 PNs no tenían dims así que no
hubo señal, pero el blanqueo en el único PN con dims era 100% reproducible.

### Root cause
El fix 1.5.13 del Bug 7 (preserve-on-missing para `partNumberDimensions`)
usaba field names equivocados al reconstruir desde `existingPnNode`:

```js
// 1.5.13 — INCORRECTO:
dims = (existingPnNode?.partNumberDimensionsByPartNumberId?.nodes || [])
  .filter(d => !d.archivedAt && d.dimensionId && d.unitId != null)
  .map(d => ({ dimensionId: d.dimensionId, microQuantity: d.microQuantity, unitId: d.unitId }));
```

- La respuesta de `GetPartNumber` usa
  `{geometryTypeDimensionTypeId, dimensionValue, unitByUnitId{id}}`.
- El filter `d.dimensionId` siempre devolvía falsy → rechazaba todos los
  nodos → `dims = []` → SH REPLACE blanqueaba los 3 dims existentes.
- El map también estaba mal: la shape del input `SavePartNumber.partNumberDimensions`
  es `{geometryTypeDimensionTypeId, unitId, dimensionValue}` (ver
  `buildDimensions` ~línea 1420).

Confirmado con snapshot pre del piloto (`pilot_pre_2026-05-30.json`):
```json
{"geometryTypeDimensionTypeId": 755, "dimensionValue": 120, "unitId": 4685}
```

### Fix
`bulk-upload.js:5269-5275`:

```js
// 1.5.14 — CORRECTO:
dims = (existingPnNode?.partNumberDimensionsByPartNumberId?.nodes || [])
  .filter(d => !d.archivedAt && d.geometryTypeDimensionTypeId && (d.unitByUnitId?.id ?? d.unitId) != null)
  .map(d => ({
    geometryTypeDimensionTypeId: d.geometryTypeDimensionTypeId,
    dimensionValue: d.dimensionValue,
    unitId: d.unitByUnitId?.id ?? d.unitId,
  }));
```

### Restore del PN afectado por 1.5.13
PN 2843345 restaurado vía `SavePartNumber` single-call con los 3 dims del
snapshot pre + `inventoryItemInput` reconstruido para preservar las 2 UCs
que sí estaban bien. Script: `/tmp/restore_pn_c_dims.py --exec`.
Verificación live: 3 dims + 2 UCs.

### Validación 1.5.13 (resumen)
Lo que SÍ funcionó del 1.5.13 (no tocar): preserve-on-missing en
`customInputs` (Bug 5), `descriptionMarkdown`/`customerFacingNotes` (Bug 5b),
`inventoryItemInput` (Bug 8), `optInOuts` tri-state (Bug 3), no-skip
silencioso de proceso vacío (Bug 1).

### Nota sobre `customInputs.DatosPlanificacion.montoMinimoUSD`
En el piloto se vio que `montoMinimoUSD` se blanquea — **esto es
intencional**, no bug. El monto mínimo ahora se valida en la UC del lote
del inventory item, no en el customInput. `mergeCustomInputs` deja
explícitamente fuera ese campo.

### Deploy
- `remote/config.json`: version 1.6.19 → 1.6.20, `lastUpdated` 2026-05-30T16:00.
- `bulk-upload.js`: `VERSION = '1.5.14'`.

## 1.5.12 (2026-05-30) — Proceso no encontrado: modal blocking (preserve vs abort)

### Síntoma
La fórmula del Excel que genera la columna `Proceso` resuelve a un texto literal
(ej. `"Combinación no existente"`) cuando no encuentra match contra la matriz
de acabados/metales. Hasta 1.5.11, ese texto llegaba al script y el resolver
de procesos hacía `throw new Error("Proceso \"X\" no encontrado en Steelhead.")`
**abortando toda la corrida** — incluso si el operador en realidad quería
preservar el proceso ya cargado en el PN (es decir, no tocarlo).

### Diagnóstico
- `bulk-upload.js:3495` (antes del fix) hacía `throw` síncrono dentro del loop
  `for (const pname of uniqueProcessNames)`.
- El post-process en `~líneas 3753-3779` ya soportaba 3 semánticas para el
  CSV: nombre válido = set ese proceso; `-` = BORRAR default; `""` = heredar
  del PN existente (con error y skip si NEW sin default).
- El path "heredar" (vacío) era exactamente lo que el operador quería para los
  nombres unresolved, pero no había forma de llegar ahí sin re-editar el CSV.

### Fix
Dos cambios en `remote/scripts/bulk-upload.js`:

1. **Nuevo helper `confirmUnresolvedProcesses(names)`** (~línea 2010): modal
   blocking que lista los nombres únicos no encontrados y devuelve
   `Promise<'preserve' | 'abort'>`. Reutiliza `createOverlay` y `injectStyles`
   del patrón existente. El texto explica explícitamente la equivalencia
   "preservar = vacío = heredar".

2. **Loop de resolución refactor** (`~líneas 3521-3559`):
   - Acumular nombres unresolved en `unresolvedNames = new Set()` en vez de
     throw inmediato.
   - Al terminar el loop, si `unresolvedNames.size > 0`:
     - Log de cuántos nombres y cuántas filas afectadas.
     - `await confirmUnresolvedProcesses([...unresolvedNames])`.
     - `'abort'` → `throw new Error(...)` como antes, corrida cancelada con
       mensaje legible.
     - `'preserve'` → `for (const p of parts) if (unresolvedNames.has(p.procesoOverride)) p.procesoOverride = '';`
       — esto los manda al path "vacío" del post-process existente; no hay que
       tocar más código aguas abajo.

### Semántica final del CSV (sin cambios para los otros 3 casos)

| Valor en CSV | Comportamiento |
|---|---|
| nombre válido | Set ese proceso como default del PN |
| `-` (dash) | BORRAR el default del PN (queda null) |
| `""` (vacío) | Heredar del PN existente; si NEW → error y skip |
| **nombre inválido + Preservar (NUEVO)** | **Equivale a vacío** → heredar; si NEW → error y skip |
| nombre inválido + Cancelar | Aborta la corrida con mensaje legible |

### Por qué este shape de modal y no per-nombre
La fórmula del Excel típicamente produce 1-3 valores literales distintos
(`"Combinación no existente"`, `"#N/A"`, etc.) repetidos en muchas filas. Un
solo prompt con la lista de únicos es suficiente; per-nombre sería tedioso
sin ganancia real.

### Plan de validación pendiente
- [ ] Probar con CSV que tenga 1 nombre inválido en N filas → modal aparece →
      "Preservar" → verificar que las N filas conservan el proceso del PN.
- [ ] Probar con CSV que tenga el nombre inválido en 1 PN NEW → "Preservar" →
      verificar que aparece en `errors[]` con "Proceso vacío en PN NUEVO" y se
      skipea (resto de la corrida continúa).
- [ ] Probar "Cancelar" → verificar que el run aborta con mensaje claro.

### Archivos afectados
- `remote/scripts/bulk-upload.js` — helper + loop refactor + header comment
- `remote/config.json` — version `1.6.17` → `1.6.18`, `lastUpdated`

## 1.5.11 (2026-05-29) — enrich-orphan visible: reportar PNs sin entry en pnLookup

### Síntoma
Corrida `bulk-upload-report-139b77b8` (cliente 166246, 121 PNs procesados).
La quote 197 tenía factura asociada y los chunks de `SaveManyPartNumberPrices`
del cliente 166246 rebotaron 7 veces con:
```
Cannot modify quote - part number prices are referenced by ...
```
Resultado en SH: **27 PNs nuevos (NEW Pase 3, todos `46004-XXX-XX`, Cobre,
IBMS 62109-62XXX)** quedaron con `customInputs={}`, `labelIds=[]`,
`partNumberDimensions=[]`, **sin línea, sin depto, sin specs**. Pero **el log
nunca lo reportó** — solo aparecían los 7 errores de `SaveManyPNP` y los 12
errores totales del run. El operador descubrió el blanqueo abriendo PNs uno
por uno en la UI de SH.

Los 18 MODIFY Pase 3 del mismo cliente NO se notaron afectados porque ya
existían en SH y conservaron lo previo — el problema solo es visible cuando
el PN nace en esta corrida.

### Diagnóstico

`enrichWorker` (línea 4775 antes de 1.5.11):
```js
const entry = pnLookup.get(idx);
if (!entry) return;
```

Cadena:
1. **STEP 2a** crea los PNs nuevos con payload mínimo (`customInputs:{}`,
   `labelIds:[]`, `dims:[]`, `specsToApply:[]`) — por diseño: solo reserva
   el `id` para que STEP 4/6 hagan el enrich.
2. **STEP 4** (`SaveManyPartNumberPrices`) falla → los `qpnp` de esos PNs
   nunca quedan en la quote.
3. El bloque que construye `pnLookup` (línea 4540-4548) itera sobre
   `qpnp.partNumberPriceByPartNumberPriceId` de la quote — si el `qpnp`
   no se commiteó, el PN nunca entra al lookup.
4. **STEP 6 `enrichWorker`** llega para ese `idx`, hace `pnLookup.get(idx)`
   → `undefined` → `return` silencioso. **Ni Call A (labels + customInputs)
   ni Call B (specs + dims + línea/depto + predictivos) se ejecutan.**
5. El operador no ve nada en el log porque el `return` no warneaba ni
   empujaba a `errors[]`.

### Fix

Reemplazar el `return` silencioso por un error explícito que cubra ambos
casos (NEW y existing huérfanos):

```diff
 const entry = pnLookup.get(idx);
-if (!entry) return;
+if (!entry) {
+  const stMiss = pnStatus[idx];
+  const kind = stMiss?.status === 'new' || stMiss?.status === 'forceDup' ? 'NEW' : 'existing';
+  errors.push(`Enrich "${part.pn}" (cust:${part.customerId}) omitido: ${kind} sin entry en pnLookup — probable SaveManyPNP rechazado en su quote. Re-correr este PN solo.`);
+  if (kind === 'NEW') state.counters.errors++;
+  return;
+}
```

Decisión:
- **NEW sin entry** → cuenta como error porque el PN quedó incompleto en SH.
- **existing sin entry** → solo aviso (el PN ya estaba enriched en SH desde
  antes; el run no perdió nada — pero el operador debe saber que esa fila
  CSV no aplicó).

### Mitigación operativa cuando aparece

1. Identificar la quote bloqueada (mismo cliente que el PN huérfano).
2. Validar con `tools/check-quote-lock.js` (DevTools script — busca refs a
   invoice en el response de GetQuote).
3. Desbloquear: cancelar/borrar el invoiceLineItem que la traba, o usar
   una quote nueva.
4. Re-correr el CSV-slice de los PNs afectados. Como ya tienen id en SH,
   bulk-upload los clasifica como **Pase 1 IBMS = MODIFY existing** y el
   enrichWorker corre normal (no depende del flow de quote para existing).

### Plan de validación

1. Pilot: re-correr los 27 PNs del cliente 166246 con quote 197 ya
   desbloqueada → confirmar que ahora todos tienen labels/línea/depto/
   customInputs/specs en SH.
2. Estrés sintético: forzar otra quote a estar lockeada y validar que el
   reporte XLSX trae los `Enrich "..." omitido: NEW sin entry` en la hoja
   Errores.

### Pendientes derivados

- Plan de "auto-mitigación": detectar `Cannot modify quote` durante STEP 4
  y degradar a SOLO_PN para ese chunk — los PNs se enrichen igual pero
  sin quote attachment. Requiere validar que la cotización viva no quede
  en estado inconsistente.

---

## 1.5.10 (2026-05-28) — FIX: archive-dups HTTP 400 con dims malformados

### Síntoma
Pilot run de 10 PNs con 1.5.9 (`bulk-upload-report-eb242ade`) — 9/10 fallaron con:
```
Archive dups <NP> HTTP 400: Variable "$input" got invalid value {} at "input[0].partNumberDimensions[0]"; Field "dimensionId" of required type "Int!" was not provided.
```
Mismo síntoma que los 21 PNs que erroraron en la corrida v104 (bug #17 de la
post-mortem). El cleanup de la regla 1.4.38 (STEP 6b — archive de
specFieldParams duplicados) construye un `UpdatePartNumber` mínimo que incluye
`partNumberDimensions` rebroadcasteado tal cual viene de `GetPartNumber` —
y para estos PNs SH devuelve filas con `dimensionId=null`, `unitId=null`.
Cuando esos `null` se serializan a JSON, GraphQL los ve como `{}` y rechaza
el input.

### Diagnóstico

`cleanupExistingDims` (línea 5599 — STEP 6b) hacía:
```js
const cleanupExistingDims = (pnNode.partNumberDimensionsByPartNumberId?.nodes || [])
  .filter(d => !d.archivedAt)
  .map(d => ({ dimensionId: d.dimensionId, microQuantity: d.microQuantity, unitId: d.unitId }));
```
Filtraba solo por `archivedAt`. Para los PNs afectados, SH devolvía rows
"huérfanos" con todos los campos nulos (legacy data o corrupción histórica).
El mapper las pasaba al payload → HTTP 400 → cleanup no se ejecutaba →
specFieldParams duplicados quedaban vivos en el PN.

### Fix

One-liner — filtrar también `dimensionId` y `unitId` no-null antes del map:
```diff
 const cleanupExistingDims = (pnNode.partNumberDimensionsByPartNumberId?.nodes || [])
-  .filter(d => !d.archivedAt)
+  .filter(d => !d.archivedAt && d.dimensionId && d.unitId != null)
   .map(d => ({ dimensionId: d.dimensionId, microQuantity: d.microQuantity, unitId: d.unitId }));
```

Resultado: dims malformados se ignoran silenciosamente — el cleanup procede
con dims válidos (o ninguno) y el archive-dups completa el commit en SH.

### Plan de validación

1. Re-generar CSV pilot de 10 PNs con `customInputs` poblados (ver tools).
2. Verificar 0 errores `Archive dups HTTP 400` en el report.
3. Validar snapshot BEFORE/AFTER de `customInputs` para confirmar que 1.5.9
   no fue regresionado (preservación intacta).

### Pendientes derivados

- Aplicar la misma defensa en el resto de payloads de `UpdatePartNumber` /
  `SavePartNumber` que rebroadcasten dims del fetch (Call A/B, STEP 5).
- Investigar de dónde salen los rows `{dimensionId:null, unitId:null}` en SH
  — probablemente legacy de un import antiguo. Worth auditar y archivar.

---

## 1.5.9 (2026-05-28) — FIX CRÍTICO: preservar `customInputs` en MODIFY

### Síntoma
Post-mortem del recovery dual-source v104 (corrida `bulk-upload-report-82432bc9`,
~16,343 PNs procesados). El operador reportó que los 21 PNs que fallaron con
`Archive dups HTTP 400` no tenían `customInputs` — específicamente `QuoteIBMS`.
Al inspeccionar más a fondo:

- **Sample estratificado de 50 PNs** (script `inspect-ci-damage-sample.js`):
  - 40/50 (**80%**) tenían `customInputs` **totalmente vacío**.
  - 40/50 (**80%**) tenían `DatosAdicionalesNP` vacío.
  - 0/50 conservaban `QuoteIBMS`.
  - 2/50 conservaban `BaseMetal`.
  - 0/50 conservaban `DatosPlanificacion` o `NotasAdicionales`.

Daño estimado a escala completa: **~13,000 PNs blanqueados totales** + **~3,000
con merge parcial** (solo lo que el CSV traía sobrevivió, el resto se borró).

### Diagnóstico

`extractPNShape(n)` (línea 1517) construye el shape mínimo que alimenta a
`classifyPNs` y `enrichWorker`. Hasta 1.5.8 NUNCA guardaba el objeto
`customInputs` en el shape — derivaba dos strings de conveniencia (`metalBase`,
`quoteIBMS`) y descartaba el resto.

En STEP 6 (`enrichWorker`, línea 4995):
```js
const mergedCI = mergeCustomInputs(pn.customInputs, part);
```
recibía `existing = undefined` → `mergeCustomInputs` arrancaba con `{}` vacío.
Dos paths de daño:

1. **CSV vacío en customInputs (diff-mode del dual_source_recovery):**
   `mergeCustomInputs` no agrega nada → devuelve `null` (por
   `Object.keys(ci).length > 0 ? ci : null`) → el fallback en Call A/B
   ```js
   customInputs: mergedCI || pn.customInputs || {}
   ```
   bajaba a `{}` → SH (REPLACE-semantics) borraba todo el `customInputs` del PN.

2. **CSV con SOLO algunos campos:** mergeCustomInputs devolvía únicamente esos
   campos (ej. `{DatosAdicionalesNP:{BaseMetal:...}}`) → SH borraba todo lo
   demás (`QuoteIBMS`, `EstacionIBMS`, `Plano`, `DatosFacturacion`, etc).

El STEP 6b cleanup (línea 5572) **no fue afectado** — usa `pnNode.customInputs`
desde `GetPartNumber` (full fetch).

### Fix

One-liner en `extractPNShape` — agregar `customInputs: ci || null` al return.
`ci` ya estaba poblado dentro de la función desde el parsing existente del
nodo de `AllPartNumbers`. Con `existing` correctamente poblado,
`mergeCustomInputs` hace deep clone + overlay del CSV preservando los campos
no tocados.

```diff
   return {
     id: n.id,
     name: n.name,
     customerId: n.customerByCustomerId?.id || n.customerId,
     metalBase,
     quoteIBMS,
+    customInputs: ci || null,
     labels,
     labelObjs,
     archivedAt: n.archivedAt || null,
     defaultProcessNodeId: ...,
     processName: ...,
   };
```

### Por qué el bug pasó tan tiempo desapercibido

- En cargas de cotización **legacy** (`v9`, `v10` template), el CSV traía
  típicamente `BaseMetal`, `QuoteIBMS`, `CodigoSAT`, etc. en cada fila, así que
  `mergeCustomInputs` reconstruía un payload "completo enough" desde el CSV
  → el blanqueo era cosmético (perdías sólo `NotasAdicionales` y campos no
  contemplados en el template).
- El **diff-mode** del `dual_source_recovery.py` v1.0.3+ rompe esa premisa:
  intencionalmente emite columnas vacías cuando la BD coincide con SH (para
  minimizar payload). El bug latente se volvió daño masivo.

### Versiones
- `BU_VERSION`: 1.5.8 → 1.5.9
- `config.version`: 1.6.13 → 1.6.14
- Commits: pendientes de approval del usuario antes de commit/deploy

### Plan de validación
1. **Pre-deploy**: smoke test local con un CSV de 5 PNs en diff-mode (CSV sin
   cols de customInputs). Inspeccionar `customInputs` post-run en SH para los
   5 vs el snapshot pre-run — debe quedar **byte-exact**.
2. **Pre-deploy**: smoke test con CSV trayendo SOLO `BaseMetal`. Inspeccionar
   que `QuoteIBMS`, `EstacionIBMS`, etc. **se preserven** del PN existente.
3. **Post-deploy**: reanudar plan de recovery (#18) SOLO después de #23
   (inventario) + #24 (restauración del daño previo).

### Pendientes derivados
- #23: inventariar los 16,343 PNs del recovery v104 contra BD original para
  saber exactamente cuántos quedaron blank vs parcial.
- #24: armar script de restauración que repinte `customInputs` desde BD
  (TLC + MTY) para los PNs afectados.
- Caso adicional a investigar (no bloqueante): el campo
  `partNumberLocations` también se manda como `[]` literal en Call A/B,
  mismo patrón de pérdida potencial — verificar en próximo audit.

---

## 1.5.8 (2026-05-28) — Hot-patch anti-freeze del prefetch (yield + drain + cap log)

### Síntoma
Operador reportó que en runs masivos (CSV > 3000 filas) Edge se "pasma" durante
la fase **"Prefetch PNs activos"** y se lleva entre las patas otras
aplicaciones del sistema. El gauge del panel se mantenía estable en ~370 MB de
JS heap. **Nunca llegaba a la pantalla de preview** (decisiones / MODIFY). La
queja literal: "antes del refactor de corrección de bugs ya funcionaba de
manera confiable" — el usuario podía dejarlo corriendo desatendido.

### Diagnóstico
El comentario del Fix CC v3 en `bulk-upload.js:3553` ya tenía la pista:
*"prefetch global de ~22k PNs activos + 24k archivados, ~1.7GB baseline"*.

El JS heap reportaba 370 MB porque `performance.memory.usedJSHeapSize` es
**solo el heap del renderer del tab**. El freeze sistémico viene de la suma de
buffers fuera de ese número:

| Fuente | Vive en | Visible en `performance.memory`? |
|---|---|---|
| Apollo `InMemoryCache` de la SPA host | JS heap del renderer | sí (parcial) |
| Response objects pendientes de GC | Network process de Edge | **no** |
| Datadog Session Replay buffer + DOM observers | Worker + GPU process | **no** |
| `sa_last_log` (localStorage growth) | Browser process | **no** |
| DOM/CSS del panel + log textContent | Compositor / GPU | **no** |

Cuando `prefetchPNsByCustomer` ejecuta 250-500 round-trips en serie sin ceder
al event loop:

1. **Datadog seguía grabando** los primeros segundos — `stopDatadogSessionReplay()`
   se invocaba DESPUÉS de `showPanel()` (líneas 3092 vs 3096), así que la
   creación del DOM del panel + el primer pico de fetches quedaba en el buffer
   del SDK.
2. **El loop no respiraba**: no había un solo `await new Promise(r => setTimeout(r, 0))`
   en las pasadas NO + YES. El renderer no podía GC los Response parseados ni
   repintar el progress bar entre páginas.
3. **El Apollo drain solo se disparaba a ≥70% del JS heap** (vía `startMemoryGauge.tick`).
   Con runs que mantenían el heap del renderer chico (370 MB) pero saturaban
   los procesos auxiliares, el drain **nunca corría** durante el prefetch.
4. **`_log` en `steelhead-api.js` era unbounded**: cada `log()/warn()` empujaba
   al array y disparaba `_persist()` síncrono — `JSON.stringify` del array
   completo + `localStorage.setItem` bloqueando main thread. O(n²) en runs
   largos.
5. **`massiveMaxResults` defaulteaba a 100,000** — techo arbitrario alto que
   permitía iterar bloques fantasma si la paginación devolvía continuidad.

### Fix

**1. Mover `stopDatadogSessionReplay()` antes de `showPanel()`** (línea ~3091)

Ahorra el primer pico de buffer mientras se construye el DOM del panel.

**2. Yield + drain periódico en `prefetchPNsByCustomer`** (líneas ~1438 NO y ~1469 YES)

Tras cada página:
```js
const pageIdxNo = (offset / pageSize) | 0;
if (pageIdxNo > 0 && pageIdxNo % 5 === 0) stopDatadogSessionReplay();
await new Promise(r => setTimeout(r, 0));
```

El `stopDatadogSessionReplay` después del primer call queda idempotente (latch
`window.__sa_dd_stopped`) y solo dispara Apollo `clearStore()` silencioso — es
el drain periódico que faltaba.

**3. Mismo tratamiento en `classifyPNsOnDemand`** (loop por PN único, línea ~1740)

Cada 25 PNs único: drain + yield. Más espaciado porque inner page loop suele
ser 1-2 páginas, no necesita drain per-página.

**4. Cap `_log` a 500 entradas + debounce `_persist` a 200ms** (`steelhead-api.js`)

Ring buffer evita growth O(n²). Debounce evita N writes síncronos por segundo.

**5. `massiveMaxResults: 50000`** en `config.json`

Cubre Ecoplating con headroom (~46k catálogo histórico) y elimina el techo
fantasma de 100k.

### Versiones
- `BU_VERSION`: 1.5.7 → 1.5.8
- `config.version`: 1.6.12 → 1.6.13
- Commits: pendientes (deploy en curso)

### Plan de validación
1. Recargar extensión (chrome://extensions → reload).
2. Re-subir el CSV de >3000 filas que estaba congelando.
3. Verificar:
   - Panel debe avanzar página por página en "Prefetch PNs activos" SIN congelarse.
   - Edge debe permanecer responsivo (otras tabs y otras apps no se cuelgan).
   - JS heap puede subir más allá de 370 MB ahora que el flow respira — eso es
     esperado y bueno (síntoma de que NO está limitado por system swap).
   - La pantalla de preview/decisiones debe aparecer al final del prefetch.

### Pendientes derivados
- [ ] **Task #8**: documentar bulk-upload end-to-end + plan de refactor de
      optimización. Hay deuda grande de arquitectura (prefetch global del dominio,
      log unbounded, mem monitor por %, inline Datadog stop, falta migrar a
      `host-cleanup-shared.js`). El hot-patch arregla los síntomas; el refactor
      atacará la arquitectura.
- [ ] Migrar `bulk-upload.js` a `host-cleanup-shared.js` (skill `memory-hardening-applets`
      lo lista como deuda explícita).
- [ ] Considerar mem monitor con umbral ABSOLUTO en MB además del %, para que
      el guardrail dispare aún cuando el heap del renderer se mantenga bajo
      pero el browser process esté saturado.
- [ ] Evaluar prefetch targeted por customerId (en vez de barrer todo el
      dominio) — requiere análisis de hashes disponibles.

---

## VBA Module1 v14 (2026-05-28) — Predictivos sin truncar en el CSV

### Síntoma
Validación piloto (50 PNs) detectó que los consumos predictivos en SH llegaban
truncados a 4 decimales (`0.0001`, `0.0023`, ...). La plantilla viva tenía los
valores raw correctos (ej. `0.00012345`), pero el bulk-upload los recibía ya
redondeados desde el CSV. El parser `predictiveUsage` (`Math.round(usagePerPart * 1e6)`)
multiplicaba ese valor truncado por 1e6, así que el `microQuantityPerPart`
guardado en SH quedaba a una resolución de `0.0001 = 100 microQ/pza`. Para
predictivos como Antitarnish (consumos del orden 1e-5 L/pza) el truncamiento
borraba toda la señal.

### Causa
`ExportarCSV` (`vbas/Module1.txt`) hace:
```vb
tmpWb.SaveAs fileName:=savePath, FileFormat:=62  ' CSV UTF-8 nativo Excel
```
`FileFormat:=62` exporta el **valor mostrado** según el `NumberFormat` de cada
celda — no el `Value2` raw. La plantilla v11 tiene las cols predictivas
BD:BL (55..63: Plata, Estaño, Níquel, Zinc, Cobre, Antitarnish, Epox MT/BT/MTR)
con formato display de 4 decimales para legibilidad. Resultado: CSV truncado.

### Fix
En el libro temporal (no en la plantilla viva — el usuario sigue viendo 4
decimales para legibilidad), forzar `NumberFormat = "General"` en cols 55..63
justo antes del `SaveAs`. Excel exporta entonces hasta 15 dígitos significativos.

```vb
Dim predCol As Long
For predCol = 55 To 63
    tmpWs.Columns(predCol).NumberFormat = "General"
Next predCol
```

### Archivos
- `vbas/Module1.txt` bump v13 → v14
- Header del módulo documenta el bug + fix

### Deploy
Paste manual al `.xlsm`: abrir `Plantilla_Cotizaciones_v11.xlsm` → Alt+F11 →
Module1 → reemplazar contenido con `vbas/Module1.txt` → guardar. Sin deploy a
`gh-pages` (el `.xlsm` no se sirve desde GitHub Pages — la extensión sólo lo
ofrece para descarga como recurso estático). Sin bump de `BU_VERSION` ni de
`remote/config.json`.

### Validación pendiente
Cargar un PN del piloto cuyo predictivo originalmente vino truncado, exportar
CSV con el VBA v14, validar via `pilot_validate.py` que el `microQuantityPerPart`
en SH ahora coincide con el `Value2` del xlsm fuente.

---

## 1.5.3 (2026-05-28) — Match-by-id bypassea `classifyOnePN` (Pase 0 directo)

### Síntoma
Operador subió 50 PNs del piloto string-only generado por `dual-source-recovery`.
Todos llevaban `Id SH` poblado (pivote directo). Esperado: el applet detectaba
match-by-id y marcaba `MODIFY` sin pedir intervención. Real: panel mostró
**"50 decisiones pendientes"**, contradiciendo la promesa del flujo Id SH.

### Causa
`classifyPNsMassive` (líneas ~1530-1545) hacía match-by-id correctamente
(`pnsForCustomer = [node]` cuando `idSh` apunta a un PN existente), pero después
llamaba a `buildClassifiedRow` que invocaba a `classifyOnePN` SIN saber que ya
había match directo por Id. `classifyOnePN` tiene 3 pases:
- Pase 1: match por IBMS → fallaba (sin IBMS en el row).
- Pase 2: composite (metalBase + labels) → fallaba (etiquetas vacías en SH para muchos PNs cargados parcialmente).
- Pase 3: blank-candidate → caía aquí con `confidence: 'blank-candidate'` y
  `userDecided: false` → UI lo trataba como "necesita decisión humana".

El usuario fue claro: *"si ya entró con Id SH porqué no sólo me dijo: modificar?"*

### Fix
Agregado parámetro `directIdMatch = false` a `buildClassifiedRow`. Cuando es
`true` (lo pasan los 2 call sites del match-by-id, líneas 1541 y 1694), la
función devuelve directamente un shape:
```js
{
  status: 'existing' (o 'forceDup'),
  classification: 'MODIFY',
  pase: 0,
  confidence: 'idsh-direct',
  userDecided: true,        // ← clave: UI no pregunta
  targetPnId: node.id,
  wasArchived: !!node.archivedAt,
  // ...
}
```
sin pasar nunca por `classifyOnePN`.

Telemetry: `logClassificationSummary` ahora reporta `P0=N (idsh-direct)` y los
counts incluyen `pase0: N`.

### Versiones
- `BU_VERSION`: 1.5.2 → 1.5.3
- `config.version`: 1.6.6 → 1.6.7
- Commits: main `1f0e9b4`, gh-pages `5c5e93f` (deploy 1.6.7)

### Plan de validación
1. Recargar extensión.
2. Re-subir `~/Downloads/recovery_pilot_50_string_only.xlsm`.
3. Verificar log: `P0=50 (idsh-direct) P1=0 P2=0 P3=0 NEW=0 (total 50)`.
4. Verificar panel: **0 decisiones pendientes**, todas MODIFY directas.
5. Spot-check 3 PNs post-carga: las correcciones string (Línea, Departamento,
   Proceso, _labels_, Spec 1, Spec 2, Plano) deben quedar aplicadas en SH.

### Pendientes derivados
- [ ] Doc en `dom-patterns.md`: pattern de bypass para matches confirmados
  (cuando la fuente externa ya garantiza identidad, saltar heurística).
- [ ] Considerar exponer `directIdMatch` también en CSV de bulk-upload, no solo
  en xlsm (si alguna vez se reactiva el path CSV).

---


## Extensión 1.6.2 (2026-05-27) — Descargar Plantilla + Catálogos + aviso Refrescar Listas

### Cambio de comportamiento
El action `download-template` ahora hace tres cosas con un click:
1. Dispara `update-catalogs` (genera y descarga `Catalogos_Steelhead_*.xlsx`)
2. Muestra alert: "Plantilla descargada. Recuerda: al abrirla por primera vez ejecuta el botón 'Refrescar Listas' del ribbon antes de pegar datos."
3. Abre la URL de descarga del `.xlsm` (Plantilla_Cotizaciones_v11.xlsm)

### Schema extendido en `config.json`
Action `download-template` ahora soporta props opcionales:
- `afterMessage`: string — mensaje a enviar al background después de abrir URL
- `notice`: string — texto del alert al usuario

```json
{ "id": "download-template", "label": "Descargar Plantilla + Catálogos",
  "handler": "open-url", "url": "templateUrl",
  "afterMessage": "update-catalogs",
  "notice": "Plantilla descargada. Recuerda..." }
```

Los campos son **opcionales y forward-compatible**: extensiones viejas que no entienden `afterMessage`/`notice` los ignoran y solo abren la URL.

### Lección — orden importa cuando hay `chrome.tabs.create`
**1.6.1 (deploy fallido)**: implementé `chrome.tabs.create({url})` primero y `await sendToBackground('update-catalogs')` después. Falló porque:
1. La nueva tab roba foco → Chrome cierra el popup → el `await` muere
2. `getSteelheadTab()` en `background.js:127` consulta `{ active: true, currentWindow: true }` — necesita Steelhead como tab activa al momento del mensaje

**1.6.2 (fix)**: invertir orden en `popup.js` handler `open-url`:
```js
case 'open-url': {
  const url = action.url === 'templateUrl' ? config?.templateUrl : action.url;
  if (!url) { alert('URL no configurada.'); break; }
  if (action.afterMessage) {
    const result = await sendToBackground(action.afterMessage);  // ← Steelhead activo, popup vivo
    if (result?.error) alert('Catálogos: ' + result.error);
  }
  if (action.notice) alert(action.notice);  // ← popup vivo, modal se muestra
  chrome.tabs.create({ url });  // ← al final; popup puede morir libremente
  break;
}
```

**Regla general**: si vas a abrir una tab que robe foco, déjalo para el **último paso** del handler. Todo lo demás (awaits, alerts, sendMessage) debe ir antes.

### Bug v10 paralelo
`remote/config.json:templateUrl` apuntaba a `Plantilla_Cotizaciones_v10.xlsm` aunque el `.xlsm` y todo el código ya estaban en v11. Corregido a v11. Este fix **no requiere update de extensión** — solo recarga config (la extensión lee `templateUrl` dinámicamente).

### Pre-requisito de uso
- Tab de Steelhead **abierta y activa** al hacer click. `getSteelheadTab` falla con "Abre Steelhead primero" si no.
- Si falla la generación de catálogos, el flujo aún abre la descarga del `.xlsm` (priorizamos la plantilla).

### Versiones
- `extension/manifest.json`: 1.6.0 → 1.6.1 (deploy fallido) → 1.6.2 (fix order)
- `config.extensionVersion`: 1.6.0 → 1.6.2
- `config.version`: 1.6.4 → 1.6.5 → 1.6.6
- Distribución: `steelhead-automator.zip` regenerado en gh-pages

### Commits
- main: `de7bf17` (1.6.1) · `c4bd3b6` (1.6.2)
- gh-pages: `7e18e8c` (deploy 1.6.5) · `1458b87` (deploy 1.6.6)

---

## 1.5.2 (2026-05-27) — Fix log cosmético "Precios: N PNs procesados"

### Síntoma
Operador subió 1 PN en SOLO_PN. El panel mostró `1/1 OK: 1` (correcto) pero el log
de progreso decía `Precios: 20 PNs procesados`.

### Causa
En el loop de precios standalone (línea 4427), el log usaba `batchNum * 20` literal,
asumiendo que cada batch siempre va lleno (lote de 20). Con 1 PN → 1 batch
→ `1 * 20 = 20` reportado, aunque el batch real era de 1.

### Fix
```js
addPanelLog(`Precios: ${Math.min(batchNum * 20, pnpWithPrice.length)} PNs procesados`);
```
Clamp al total real de PNs con precio en la fase, no al tamaño nominal del batch.

### Lección
Logs de progreso por batch deben usar el **count acumulado real**, no el `batchNum × pageSize`.
La diferencia solo se nota en el último batch (que puede ser parcial) o en runs chicos.
No afecta funcionalidad — fue solo cosmético — pero confunde al operador y disparó esta
sesión de debug.

### Validación
Prueba en producción con 1 NP confirmó: ahora reporta `Precios: 1 PNs procesados`.

### BU_VERSION
1.5.1 → 1.5.2

---

## 1.5.1 (2026-05-26) — Notas adicionales movida + Id SH como pivote alternativo

### Cambio de layout v11 (sólo cols 65-71)
- "Notas adicionales" se movió de BS (71, última) a **BM (65)** — único campo IBMS que sobrevivirá tras dejar IBMS
- Las 6 cols que la seguían se corrieron una posición adelante (QuoteIBMS, EstacionIBMS → EstIBMS rename ligero, Plano, Piezas por Carga, Cargas por Hora, Tiempo de Entrega)
- Cols 1-64 (A..BL) **idénticas** a la v11 previa. Predictives BD..BL no se movieron.

### `V11_COLS` actualizado en `bulk-upload.js`
- `notasAdicionales` 70 → 64
- `quoteIBMS` 64 → 65
- `estacionIBMS` 65 → 66 (header pasó a "EstIBMS")
- `plano` 66 → 67
- `piezasPorCarga` 67 → 68
- `cargasPorHora` 68 → 69
- `tiempoEntrega` 69 → 70

### Fila válida = NP **o** Id SH
- `parseRows`: gate cambió de `!pn` a `!pn && !idSh` → admite filas con solo Id SH para modificación masiva
- `classifyPNsMassive`/`OnDemand`:
  - Si `idSh` matchea node existente: **MODIFY-by-id directo**. Si `pn` presente y `node.name ≠ pn` → warn (id gana) pero proceder
  - Si `idSh` presente pero NO matchea + `pn` presente nuevo → **abort** fila ("Id SH X inválido — corrige o elimínalo si quieres crear PN nuevo")
  - Si solo `idSh` sin `pn` e `idSh` no matchea → **abort** ("Id SH no encontrado y sin PN para fallback")
  - Si solo `pn` sin `idSh` → comportamiento existente (name match con dedup)
- `SavePartNumber` payload: cuando MODIFY-by-id y `part.pn` null, usa `node.name` como fallback
- `csvRowKey` y `detectCsvDuplicates`: dedup key alternativo `__idsh:<id>|<customerId>` cuando `pn` es null

### VBAs (paste manual al .xlsm)
- `VBA_Module1_v13.txt` — ExportarCSV: `lastRow = MAX(col G End(xlUp), col E End(xlUp))` para capturar filas trailing con solo Id SH
- `VBA_Module5_v12.txt` — LimpiarDatos + LimpiarEspacios: mismo cambio de gate
- `VBA_Module2_v12.txt` y `VBA_Module4_v11.txt` no requieren cambios (no usan PN para gate de fila)

### Plantilla
- `remote/templates/Plantilla_Cotizaciones_v11.xlsm` actualizado (525K, sin cambio de nombre — sigue siendo v11)

### BU_VERSION
1.5.0 → 1.5.1

### Pendientes
- [ ] Validación end-to-end con .xlsm v11 mezclando: (a) fila solo PN, (b) fila solo Id SH válido, (c) fila solo Id SH inválido, (d) fila PN nuevo + Id SH inválido (debe abortar), (e) fila Id SH matchea pero `node.name ≠ pn` (debe warn)
- [ ] Deploy a gh-pages (requiere autorización)

---

## 1.5.0 (2026-05-26) — Schema v11: Id SH, Tipo de Geometría, Línea movida

### Cambios de plantilla (Plantilla_Cotizaciones_v11.xlsm)
- 71 columnas (antes 69)
- Nuevas columnas: **Id SH** (E, opcional — fuerza match por ID interno), **Tipo de Geometría** (Q, lista con auto-creación)
- **Línea** movida antes de **Metal base**
- **Usar y archivar** descartado (probado: sólo funciona al crear NP desde OT, no en carga masiva)
- Header row 7 marca la versión: col E = `"Cliente"` → v10, col E = `"Id SH"` → v11

### Parser dual-layout (`bulk-upload.js`)
- `parseRows()` detecta versión leyendo row 7 col E y elige `V10_COLS` o `V11_COLS`
- `schemaPredictiveMaterials` derivado de `COLS.predictives` (v10: BB..BJ = 53..61, v11: BD..BL = 55..63)
- Output incluye `part.idSh`, `part.tipoGeometria`, `part.schemaVersion`
- Backwards-compatible: plantillas v10 siguen funcionando sin cambios

### Match por Id SH
- `classifyPNsMassive`/`classifyPNsOnDemand` construyen `pnById: Map<string(id), node>`
- Si `part.idSh` matchea un node existente, se usa directo (sin name-lookup)
- Si NO matchea: warn + fallback a name-match con dedup (preserva comportamiento previo, NO marca error)

### Tipo de Geometría (auto-create)
- `fetchAllGeometryTypes()` paginado al inicio del flujo
- `resolveGeometryTypeId(name)` busca por nombre; si no existe, dispara mutation `SaveGeometryType`
- Pre-resolve de nombres únicos ANTES de `runPool` evita race conditions
- Fallback a `DOMAIN.geometryGenericaId` (831) si falla la creación
- Nuevos hashes en `config.json`: `AllGeometryTypes` y `SaveGeometryType`

### `catalog-fetcher.js`
- Nuevo `fetchGeometryTypes()` paginado
- Nuevo sheet **TiposGeometria** en el archivo `Catalogos_Steelhead_*.xlsx`

### VBAs actualizadas (paste manual en el .xlsm)
- `VBA_Module1_v12.txt` — ExportarCSV adaptado a v11 (lee modo de H1, Cliente=F, PN=G, ordena por F9 y G9)
- `VBA_Module2_v12.txt` — **bugfix crítico** de RefrescarListas: removido `Range(...).Insert Shift:=xlDown` que empujaba contenido +2 filas y heredaba formato de header. Ahora escribe placeholders directo en row 2-3 e items desde row 4 (`i + 3`). Soporta TiposGeometria (col 14)
- `VBA_Module4_v11.txt` — SombrearModoSoloPN: lee modo de H1, Cantidad K9:K508, Productos X9:AI508
- `VBA_Module5_v11.txt` — LimpiarDatos + LimpiarEspacios: loop a col 71, boolCols=[1,2,3,4,15], preserveCols=[54,55], divisa default USD en col 14

### Distribución de la plantilla
- Nuevo botón en panel del applet **"Descargar plantilla v11 + catálogos"** que descarga `Plantilla_Cotizaciones_v11.xlsm` desde gh-pages + dispara flujo existente de Actualizar Catálogos + muestra aviso "Ejecuta Refrescar Listas primero"
- Plantilla servida desde `remote/templates/Plantilla_Cotizaciones_v11.xlsm` (sincronizada a gh-pages como `templates/Plantilla_Cotizaciones_v11.xlsm`)

### Pendientes
- [ ] Deploy a gh-pages (requiere autorización explícita del usuario)
- [ ] Verificar byte-exact con `tools/check-deploy.sh bulk-upload.js` y `tools/check-deploy.sh catalog-fetcher.js`
- [ ] Validación end-to-end con un .xlsm v11 real: Id SH mezclado (algunos válidos, algunos inválidos, algunos vacíos) y Tipo de Geometría con valores que no existan en el catálogo

---

## 1.4.38: regla null-only por SpecField en STEP 6b (Fix MM, 2026-05-25)

### Síntoma
Tras la regla nueva de 1.4.37 (Fix L, sentinel pre-quote + `processNodeId=null`
siempre), PNs cargados con CSV nuevo aún quedaban con **dos rows vivos** bajo
un mismo `SpecField`:

| SpecField | sfpId | Param name | processNodeId |
|---|---|---|---|
| Espesor | 250109 | "Espesor 5.8 - 8.89 µm (anterior)" | null |
| Espesor | 256114 | "Espesor 7.62 - 15.24 µm" | 81739123 |

El CSV pedía `7.62 - 15.24` pero el row con `processNodeId=null` venía de
una carga previa con sfpId distinto (5.8 - 8.89). El cleanup defensivo 1.4.9
sólo archivaba pares `null + processNode` del **mismo sfpId**, así que no
detectaba sfpIds distintos en el mismo SpecField → ambos rows sobrevivían.

### Causa raíz
- **Modelo correcto**: el `SpecField` es el contenedor — sólo puede vivir 1
  row por `specFieldId`, sin importar el sfpId. El cleanup 1.4.9 y el
  dedup-tuple original asumían que el contenedor era el `SpecFieldParam`.
- **Resultado**: cuando un PN cambiaba de sfpId entre cargas (típico cuando
  el material genérico se redefinió y los rangos de espesor cambiaron de
  catálogo), el row viejo sobrevivía como huérfano con `processNodeId=null`
  y el nuevo entraba con `processNodeId=<proceso>` — duplicación silenciosa.

### Fix
Refactor de STEP 6b (`bulk-upload.js:4777-4853`):

```js
const existingBySpecField = new Map();
for (const p of allParams) {
  if (p.archivedAt || !p.specFieldParamBySpecFieldParamId) continue;
  const sfp = p.specFieldParamBySpecFieldParamId;
  const sfId = sfp.specFieldSpecBySpecFieldSpecId?.specFieldBySpecFieldId?.id;
  if (!sfId) continue;
  if (!existingBySpecField.has(sfId)) existingBySpecField.set(sfId, []);
  existingBySpecField.get(sfId).push(p);
}
const processedSpecFields = new Set();
for (const ws of wantedSelections) {
  if (!ws.specFieldId || processedSpecFields.has(ws.specFieldId)) continue;
  processedSpecFields.add(ws.specFieldId);
  const allInSF = existingBySpecField.get(ws.specFieldId) || [];
  const matching    = allInSF.filter(p => p.specFieldParamBySpecFieldParamId.id === ws.specFieldParamId);
  const nonMatching = allInSF.filter(p => p.specFieldParamBySpecFieldParamId.id !== ws.specFieldParamId);
  for (const p of nonMatching) archiveSet.add(p.id);          // sfpId perdedores
  const matchingNulls    = matching.filter(p => !p.processNodeId);
  const matchingNonNulls = matching.filter(p =>  p.processNodeId);
  if (matchingNulls.length === 0) {
    adds.push({ specFieldId: ws.specFieldId, specFieldParamId: ws.specFieldParamId, ...
                processNodeId: null, processNodeOccurrence: null, locationId: null });
    for (const p of matchingNonNulls) archiveSet.add(p.id);
  } else {
    const sortedNulls = matchingNulls.slice().sort((a,b) => Number(b.id) - Number(a.id));
    for (const p of sortedNulls.slice(1)) archiveSet.add(p.id); // dejar 1 NULL vivo
    for (const p of matchingNonNulls)     archiveSet.add(p.id);
  }
}
```

Un solo `SavePartNumber` con `partNumberSpecFieldParamsToArchive` antes de
los `AddParamsToPartNumber`. Cero round-trips extra vs 1.4.37.

### Lección
- **SpecField agrupa, no SpecFieldParam**. El modelo de datos lo deja
  ambiguo (cada row apunta a sfpId), pero la regla de negocio es: 1 row
  vivo por SpecField. Cualquier dedup, validación o cleanup debe agrupar
  por `specFieldSpecBySpecFieldSpecId.specFieldBySpecFieldId.id`.
- **Cleanup defensivo no basta cuando el catálogo de sfpIds cambia**.
  Necesita ser proactivo: archivar TODOS los sfpIds del SpecField que no
  coincidan con el wanted del CSV, no solo reaccionar a `null + processNode`
  del mismo sfp.

### Validación previa al deploy
Script DevTools standalone (`tools/test-null-param-fix.js`) probado en PN
3027939 (CXC7807602-12, 12 rows). Dry-run + Apply confirman que la regla
deja 1 row con `processNodeId=null` por SpecField y archiva el resto.
**Bug encontrado y corregido durante la prueba**: el insert payload exige
`Int` para `specFieldId/specFieldParamId`; el script (y el bulk-upload
nuevo) hacen `Number(...)` antes de mandar.

### Pendiente de validación
- [ ] Re-correr una carga masiva real con CSV mixto (sfpId nuevo + sfpId
      viejo en mismo SpecField) y confirmar via DevTools que el PN queda
      con 1 sólo row por SpecField, todos `processNodeId=null`.
- [ ] Validator dup-params 0.4.3 (spec-migrator) sobre lote post-carga
      debe reportar 0 duplicados.

---

## 1.4.31: logging defensivo predictivos + preferencia activa en map (Fix KK, 2026-05-25)

### Síntoma
Tras deployar Fix JJ en 1.4.30, el log del run de recovery mostró
`Predictivos actualizados: 842` pero **no apareció** la línea
`Predictivos desarchivados: N/N` ni `Paso 6a/9: Predictivos (N unarchive / …)`.
Imposible saber si era (a) cache de extensión cargando script viejo, (b)
`GetPartNumber` no exponiendo `archivedAt` en su selection set, o (c)
genuinamente 0 archivados detectados.

### Fix
1. **Log incondicional** (`bulk-upload.js:4659-4661`): la línea
   `Predictivos desarchivados: X/Y (Fix JJ/KK 1.4.31)` ahora se emite siempre
   que `predTotalOps > 0`, no solo cuando hay desarchivos. Confirma visualmente
   que el código del Fix JJ está vivo.
2. **Contadores diagnósticos** (`bulk-upload.js:4170-4174` + `4203-4218`):
   `predFetchTotalNodes` y `predFetchArchivedNodes` se acumulan durante el
   pre-fetch. El log `Pre-fetched predictivos existentes de N PNs (T nodos,
   A archivados detectados)` distingue los 3 escenarios:
   - `A > 0, unarchived = 0` → bug nuevo (detecta pero no procesa).
   - `A = 0` → o no hay archivados (recovery limpia) o `GetPartNumber` no devuelve `archivedAt`.
   - `T = 0` → query no devuelve nada útil.
3. **Tie-break en mismo `itemId`** (`bulk-upload.js:4208-4215`): si el map ya
   tiene una entrada para ese `inventoryItemId`, prefiere la NO archivada (el
   archivado es el "viejo" que SavePartNumber ignoró por unique-constraint, el
   activo es el recién creado por SavePartNumber). Si solo hay archivado, ese
   queda y Fix JJ lo desarchiva. Sin este tie-break, el orden del array de
   Steelhead decidía silenciosamente cuál entraba al map.

### Lección
- **Log incondicional en bloques condicionales** cuando hay un mecanismo nuevo:
  ahorra una iteración entera de "¿se ejecutó el fix?" por una línea visible.
- **`Map<key, single>` con keys naturalmente duplicables** (mismo
  `inventoryItemId`, uno archivado + uno activo) necesita tie-break explícito.
  Mismo patrón que `pnByKey` en audit-incomplete-pns 2026-05-23.

### Pendiente de validación
- [ ] Re-correr recovery del CSV reducido de 404 incompletos con 1.4.31. El log
      debe mostrar `Pre-fetched predictivos existentes de 424 PNs (T nodos,
      A archivados detectados)` con A > 0 si hay archivados, y
      `Predictivos desarchivados: A/A (Fix JJ/KK 1.4.31)` aún cuando A=0.
- [ ] Si A=0 con re-audit que vuelve a reportar predictive missing → confirmar
      vía DevTools standalone (`gql('GetPartNumber', {partNumberId, usagesLimit:1, usagesOffset:0})`)
      que `predictedInventoryUsagesByPartNumberId.nodes[].archivedAt` se devuelve.

---

## 1.4.30: desarchivar predictives existentes en STEP 6a (Fix JJ, 2026-05-25)

### Síntoma
Re-audit post-recovery 1.4.29 dejó **404 PNs incompletos**, casi todos por
`predictive missing` concentrados en 5 materiales:

| Material | PNs faltantes |
|---|---|
| Sterlingshield S (Antitarnish) | 236 |
| Plata Fina | 159 |
| Epoxy MT | 28 |
| Epoxica BT | 6 |
| Estaño Puro | 1 |

Los otros 4 materiales del catálogo (Níquel Metálico, Zinc Metálico, Placa de
Cobre, Epoxica MT Red) reportaban 0 faltantes — discriminación demasiado
limpia para ser bug del CSV. Stats de la corrida reportaron `Predictivos
actualizados: 849` sin errores, pero el server NO los tenía visibles.

### Diagnóstico
3 piezas conspiraron:

1. **Pre-fetch (`bulk-upload.js:4198`)** lee `predictedInventoryUsagesByPartNumberId.nodes`
   completo en `existingPredictedMap`. **Sin filtrar `archivedAt`**. Activos y
   archivados quedan indistinguibles en el map.
2. **SavePartNumber filter (`bulk-upload.js:4476`)** descarta cualquier item que ya esté
   en el map para no crear duplicados. Bien para evitar unique-constraint, mal
   para los archivados: no los crea como nuevos.
3. **STEP 6a `UpdateInventoryItemPredictedUsage` (`bulk-upload.js:4624`)** modifica
   `microQuantityPerPart` del registro existente — incluyendo archivados — pero
   `UpdateInventoryItemPredictedUsage` **no toca `archivedAt`**. El record queda
   con valor actualizado pero sigue archivado.
4. El audit (`audit-incomplete-pns.js:1242`) filtra explícitamente `.filter(p => !p.archivedAt)`
   antes de comparar, por eso reporta `missing`. Lo veía como inexistente cuando
   en realidad estaba escondido en el server.

Por qué solo esos 5 materiales: son los que en la carga ORIGINAL de P3 (y/o en
algún recovery intermedio con 1.4.27 buggy) quedaron archivados — sea porque el
CSV traía `-` para ese material en algún momento, sea porque el applet pre-Fix-Y
los archivó incidentalmente. Los otros 4 materiales nunca habían sido archivados
y por eso SavePartNumber los creó limpios.

### Fix
1. **Pre-fetch (`bulk-upload.js:4200`)** ahora guarda
   `{ id, archivedAt }` por item en vez de solo `id`. El shape de
   `existingPredictedMap` pasó de `Map<itemId, recordId>` a
   `Map<itemId, { id, archivedAt }>`.
2. **STEP 6a (`bulk-upload.js:4589-4619`)** agrega tercer bucket
   `predictedUnarchives` con los IDs cuyo `archivedAt` está set y cuyo CSV trae
   valor numérico. Bonus: si CSV trae `-` para un material ya archivado, no se
   re-archiva (no-op).
3. **Orden de ejecución (`bulk-upload.js:4632`)**: `unarchives → updates → archives`.
   Desarchivar PRIMERO es crítico — si el update llega primero, el record sigue
   archivado y el audit lo seguiría viendo missing.
4. **Desarchivar** se hace vía el mismo endpoint `ArchivePredictedInventoryUsage`
   con `archivedAt: null` (Steelhead acepta nullable; ya validado por el path
   simétrico de archivar con timestamp). Pool concurrente igual al de
   archive, con offset corregido en `setPanelProgress` para reflejar las 3 fases.

### Lección
- **Pre-fetch sin filtro `archivedAt` es un foot-gun clásico** cuando hay
  endpoints que NO desarchivan implícitamente. Igual que el audit (que ya
  filtraba), bulk-upload debe filtrar antes de razonar sobre "ya existe".
- **`Update*` rara vez desarchiva** en Steelhead — son operaciones ortogonales.
  Si hay `Archive*` separado del `Update*`, asumir que el archivedAt es estado
  persistente que requiere transición explícita.
- **Cluster de faltantes en N materiales específicos = bug de estado server**
  (algunos records están en estado X que el applet no maneja), no bug de CSV
  (que sería aleatorio o uniforme).
- El stats `Predictivos actualizados: N` mentía: contaba ops exitosas pero no
  verificaba que el item terminara visible. Las verificaciones post-write
  (audit) son indispensables — confiar solo en HTTP 200 ocultó el bug por
  ~3 versiones (1.4.27 → 1.4.29).

### Pendiente de validación
- [ ] Re-cargar CSV recovery 1.4.30 (o el original P3) — verificar log
      `Predictivos desarchivados: N/N` y re-audit que `predictive missing`
      baje a ~0 (solo deberían quedar los 22 buckets `duplicateQuoteIBMS`
      que requieren DELETE manual + 1 ambiguousMatch).

## 1.4.29: sticky decision en showQuoteConflict — "aplicar a todas" (Fix II, 2026-05-24)

### Motivación
El modal de conflicto (`showQuoteConflict`) se dispara una vez por cada cotización
existente detectada. En corridas grandes con muchas cotizaciones recurrentes
(typical: re-carga de un CSV de recovery donde casi todas las cotizaciones ya
existen), el operador acababa dándole clic 100+ veces seguidas a la misma opción
("Modificar la existente"), bloqueando al applet a velocidad humana. El modal
no permitía decir "para todas las que siguen, ya sabes qué quiero".

### Fix
1. **Modal devuelve objeto en vez de string** (`bulk-upload.js:2586`):
   - Antes: `resolve('modify' | 'create' | 'skip')`.
   - Ahora: `resolve({ action: 'modify'|'create'|'skip', applyToAll: boolean })`.
   - Se agrega un checkbox debajo de los 3 botones:
     `☐ Aplicar esta decisión a todas las siguientes cotizaciones existentes de esta corrida`.
   - El estado del checkbox se lee al momento del clic del botón elegido y
     viaja en el mismo resolve — no hay otro paso extra para el operador.

2. **Caller mantiene decisión sticky en outer scope** (`bulk-upload.js:3814`):
   - Antes del loop `for (const [cid, custParts] of partsByCustomer)` se declara
     `let stickyQuoteAction = null;`.
   - En cada choque de cotización existente:
     - Si `stickyQuoteAction` está set → se reutiliza (log: `Aplicando decisión sticky: <action>`), no se muestra modal.
     - Si no → se muestra modal. Si el resultado trae `applyToAll: true`, se persiste `stickyQuoteAction = action` para los siguientes.

3. **Alcance del sticky**: vive en el run actual, atraviesa clientes y chunks.
   No persiste a IDB — si el operador re-resume después de un crash, vuelve a
   decidir desde cero (intencional: una decisión hecha hace 2 días contra el run
   actual no necesariamente sigue válida; mejor preguntar de nuevo en la primera
   colisión post-resume).

### Lección
- **UX de modales bloqueantes en batch**: cualquier modal que se dispare ≥3 veces
  en loop debe ofrecer "aplicar a todas". Sin escape hatch, el operador termina
  haciendo click-spam o abandonando el run a la mitad.
- **Devolver objeto en vez de string-enum** se paga barato cuando el handler
  necesita capturar metadata adicional al resolve (acá: `applyToAll`). Refactor
  trivial porque hay un único caller del modal.
- Mantener `stickyQuoteAction` en outer scope del loop completo (no por cliente)
  es lo natural — el operador piensa en términos de "la decisión que tomé para
  toda la corrida", no "por cliente".

### Pendiente de validación
- [ ] Probar en re-carga del CSV de recovery 1.4.28+ — marcar "modificar +
      aplicar a todas" en la primera cotización SCHNEIDER existente y verificar
      que las ~424 siguientes no muestran modal y se ejecutan automáticas con
      acción `modify`.

## 1.4.28: classifyOnePN Pase 1 — discriminar homónimos con mismo QuoteIBMS (Fix HH, 2026-05-24)

### Síntoma
Re-carga del CSV de recovery emitido por `audit-incomplete-pns` (425 SCHNEIDER
incompletos) reportó **463 OK / 0 errores** en el modal y xlsx, pero el re-audit
posterior dejó **412 PNs todavía incompletos** (97% de los originales). El cluster
era SCHNEIDER ELECTRIC MEXICO. xlsx `Resumen` decía 463 MODIFY Pase 1 (IBMS), 0
errores, 0 unknownLabels — perfecto en papel. Realidad: los labels/specs nunca
tocaron los PNs que el audit señalaba.

### Diagnóstico
1. **Test directo manual** (snippet de consola replicando `SavePartNumber-A`):
   `labelIds=[Plata Flash, Antitarnish, Empaque, SRG]` aplicó perfectamente al PN
   2867612. El shape de Call A funciona; el bug NO era partial-success silencioso.
2. **Inspección del resume state IDB**: 463 PNs en `completedPNs` con
   `pnSucceeded=true` (Fix Y gating de 1.4.15) → Call B retornó éxito para los 463.
3. **Smoking gun**: `AllPartNumbers searchQuery="1221-086412"` reveló **DOS PNs**
   en SCHNEIDER con `customInputs.DatosAdicionalesNP.QuoteIBMS=52675`:
   - **2867612** "1221-086412" (creado 2025-11-19) — el que el CSV apuntaba
   - **3028592** "1221-086412 PROYECTO BARRAS" (creado 2026-01-08) — homónimo casi-exacto
4. **`classifyOnePN` Pase 1** (`bulk-upload.js:5469` pre-fix):
   ```js
   const byIbms = allPns.find(p => (p.quoteIBMS || '') === csvIbms);
   ```
   `find()` devuelve el **primer** match. Como `AllPartNumbers` ordena `ID_DESC`,
   el primero en aparecer es el de mayor ID (3028592). El recovery aplicó MODIFY +
   Call B al 3028592 (que ya tenía los labels). El 2867612 quedó **intacto**, audit
   re-detecta missing → loop infinito de "recovery que no recupera".

El bug existía desde 1.1.0 (introducción del Pase 1 IBMS) pero solo manifestó
cuando un cliente acumuló duplicados QuoteIBMS — caso confirmado por el propio
audit post-fix-2026-05-23 (22 buckets en SCHNEIDER). El audit ya discrimina con
`fingerprint matching` (Fase 5.4b); bulk-upload no.

### Fix (`bulk-upload.js:5467`)
Tres-niveles en Pase 1:
1. **1 candidato con ese QuoteIBMS** → MODIFY directo, `confidence: ibms-exacto`
   (compatible con renombres post-IBMS donde el name cambió pero el IBMS persiste).
2. **N candidatos con ese QuoteIBMS, uno matchea name exacto** (UPPER+trim) → MODIFY
   directo, `confidence: ibms+name-exacto`.
3. **N candidatos con ese QuoteIBMS, ninguno matchea name** → **NO escoge ciego**;
   cae a Pase 2 (composite key `metalBase + labels sorted`) que es estricto, o a
   Pase 3 (name+labels) si tampoco resuelve.

Mismo patrón que el audit Phase 5.4b aplicó en fix-2026-05-23.

### Lecciones
- **`find()` por clave "única" sin verificar uniqueness es bomba de tiempo** cuando
  la clave depende de datos del cliente (QuoteIBMS lo asignan procesos IBMS externos
  que no garantizan unicidad en Steelhead). Patrón análogo al `Map<key, single>` que
  el audit ya había sufrido (ver `audit-incomplete-pns.md` §2026-05-23).
- **`okSP++` sin verificar persistencia destruye la confianza del reporte**: el
  xlsx Resumen "463 OK" mintió porque Call B aplicó cambios al PN equivocado —
  el server respondió 200, pero el PN que el operador esperaba modificar no se
  tocó. Pendiente derivado: el reporte debería incluir `targetPnId` por fila
  para que el operador pueda verificar a-posteriori.
- **El audit no es ground truth automáticamente**: el audit y bulk-upload usan
  reglas de matching distintas. Si bulk-upload escoge un PN y audit otro, los
  reportes son inconsistentes. Mantener ambos en sync con el mismo discriminador
  es un invariante a defender.

### Daño colateral pre-fix
- ~22+ PNs homónimos en SCHNEIDER fueron "pisados": MODIFY-clean borró sus PNPs y
  Call B reaplicó labels/specs/predictives. Como esos homónimos ya tenían los
  mismos labels (ambos del mismo IBMS), el daño visible es mínimo en labels pero
  podría haber alterado specs/predictives específicos del homónimo. Auditar
  manualmente revisando los duplicados que el audit identificó.
- PNs originales (los que el CSV realmente apuntaba) quedaron intactos — siguen
  siendo el target correcto del re-recovery con 1.4.28.

### Validación pendiente
- [ ] Re-cargar el CSV recovery con 1.4.28 — debe resolver al 2867612 (etc.) y
      aplicar labels/specs/predictives correctamente.
- [ ] Re-audit del mismo CSV post-recovery — debería bajar incompletos de 412 a ~0.
- [ ] Snippet de inventario: contar PNs SCHNEIDER con QuoteIBMS duplicado y
      reportar pares (name, id) para que el operador decida si archivar duplicados
      históricos.

### Pendientes derivados
- [ ] `dedupModifyTargets` (referenciado en línea 4 de la cabecera del archivo) usa
      misma regla que `classifyOnePN` — verificar que también se actualice si hay
      lógica similar.
- [ ] Reporte xlsx: agregar columna `targetPnId` en `Decisiones` para que el
      operador valide post-run que cada fila apuntó al PN esperado.
- [ ] Sincronizar el discriminador entre bulk-upload, audit y portal-importer
      (cualquier flujo que matchee PNs por QuoteIBMS).

## 1.4.27: migración localStorage → IndexedDB para resume (Fix GG, 2026-05-24)

### Síntoma
Operador reporta `Failed to execute 'setItem' on 'Storage'` tras 5-7 corridas de
CSVs ≥ 3000 PNs (Schneider Generales 4270 P1). El resume per-CSV pesa 1-2 MB
serializado (completedPNs, syncParamsCompletedPNs, identifierEnrichDone,
archivedSentinelsPreQuote, classifications, etc.) y `localStorage` cubre
~5-10 MB por origen → tope alcanzado.

### Diagnóstico
`localStorage` es síncrono, string-only y con quota estrecha por origen.
Resume completo del Schneider Generales P1 (4270 PNs, 1.4.24): ~1.7 MB.
Tras 3-4 corridas el quota explota — y como `persistResumeState` no era best-effort
realmente (corre await), un bump fallido aborta el run en lugar de degradar
silenciosamente.

### Fix
1. **Wrapper IDB compartido (`saIdb` / `saIdbGet/Set/Del/Keys`)**: db `sa_storage`,
   store `kv`. API minimalista; abre lazy y cachea la promise. Lanza si IDB no
   disponible (incognito), call sites ya tienen try/catch.
2. **Helpers de resume async**: `loadResumeIndex`, `saveResumeIndex`,
   `loadResumeStateByKey`, `deleteResumeStateByKey`, `purgeOldResumeStates`,
   `persistResumeState` ahora regresan promesas. Payload sigue siendo
   `JSON.stringify` del state (mismo shape que antes — copy directo del migrator).
3. **Migración one-shot `migrateLocalStorageToIdb()`**: idempotente vía marker
   `sa_bulk_idb_migrated_v1`. Copia keys `sa_bulk_resume_*` y `sa_bulk_resume_index`
   a IDB y las borra de LS. Best-effort: si IDB falla, deja LS intacto y los
   helpers se degradan en silencio.
4. **3 call sites en `execute()` con await**: `purgeOldResumeStates`,
   `loadResumeStateByKey`, `deleteResumeStateByKey`. Los fire-and-forget
   (`persistResumeState().catch(()=>{})`) ya estaban escritos así.

### Por qué IDB
- **Cuota ~50% del disco** vs 5-10 MB de LS → ~3-4 órdenes de magnitud más.
- **Async no bloquea el main thread**: el persist de 1.7 MB ya no congela el
  panel ~50ms cada N=100 PNs.
- **Compartible**: la misma db `sa_storage` está disponible para que otros
  applets reúsen el wrapper (el audit tool ya lo duplicó).

### Lección
- **localStorage es trampa para state grande**: si vas a serializar >100 KB
  por key, migra a IDB desde día 1. El error solo aparece bajo carga real (CSVs
  grandes después de varias corridas), no en testing.
- **Migración idempotente con marker key**: pattern simple — primer call
  verifica `await saIdbGet(markerKey)`, si existe no-op; si no, copia + escribe
  marker. Permite re-deploy sin perder estado y soporta usuarios viejos.
- **API externa estable**: mantener los mismos nombres de función al migrar
  sólo cambia el modificador (`function` → `async function`) — los call sites
  se actualizan agregando `await`. No requirió refactor de la lógica del pipeline.

### Pendiente
- [ ] `sa_load_history` (línea 5227+, lista de 50 corridas) sigue en localStorage.
  Es chico (~50 KB total con cap) pero por consistencia conviene migrarlo
  también en una pasada futura.

### B incluido (instrumentación predictive parser)
También en 1.4.27 — para diagnosticar los `predictive: 437` huecos del re-audit
P3, se agregó un debug opt-in al parser de `predictiveUsage` (parseRows). Cuando
`bulkCfg().debug.logPredictiveParse === true` (default ON en config.json hasta
diagnóstico cerrado), las primeras N rows con PN válido (default 20) emiten un
`console.groupCollapsed` con tabla `{ material, col, raw, outcome, sent }` por
cada celda BB..BJ. Esto permite ver si:
- valores con coma decimal se interpretan correcto (gn parsea `0.0003` vs `0,0003`),
- raw `-` se clasifica como dash (outcome `dash`),
- raw número se normaliza a value (outcome `value`),
- raw no-vacío se descarta silenciosamente (outcome `dropped(raw=..., gn=null)`)
  — este caso es el sospechoso #1 para huecos legítimos.

Apagar el flag (config.json) después de cerrar el diagnóstico para no inundar
la consola en runs grandes.

---

## 1.4.25: auditoría completa del modal — todos los pasos hablan (Fix FF, 2026-05-23)

### Síntoma
Operador reporta modal mudo en varias fases: muestra "Paso 2/9: Creando PNs nuevos... 9/9 0 PNs creados" durante TODO el chunk loop de cotizaciones, durante STEP 6a (predictivos), STEP 6b (sync params) y STEP 8 (archive). El log de consola sí avanzaba (`SCHNEIDER ELECTRIC MEXICO chunk N/15: ya completado...`), pero el panel daba la impresión de estar congelado. Pidió "de una vez revisa todos los pasos donde se quede mudo".

### Diagnóstico
Audit completo de `setPanelPhase` calls reveló 6+ lugares donde una segunda llamada sobreescribía el prefix "Paso N/9" puesto líneas antes, más fases sin numerar:

| Fase | Problema |
|---|---|
| Chunk loop (cotizaciones) | **No tenía** `setPanelPhase('Paso 3/9: ...')` — saltaba directo del Paso 2 al Paso 4.5 visualmente. |
| Desarchive pre-enrich | `setPanelPhase('Paso 4.5/9')` seguido de `setPanelPhase('Desarchivando PNs...')` sin prefix → borraba la numeración. |
| Archive sentinel pre-quote | Mismo patrón: línea con prefix + línea sin prefix lo sobreescribía. |
| Pre-fetch predictivos | `setPanelPhase('Pre-fetch predictivos...')` sin "Paso 6/9". |
| Enriqueciendo PNs (pool) | `setPanelPhase('Enriqueciendo PNs (pool N)')` sin "Paso 6/9". |
| STEP 6a Predictivos | No tenía `setPanelPhase` en absoluto — solo `setPanelSubPhase` por item. Modal quedaba en STEP 6 antiguo. |
| STEP 6b Sync params | `setPanelPhase('Sync params spec...')` sin "Paso 6b/9". |
| Releyendo precios | `setPanelPhase('Releyendo precios...')` sin "Paso 8a/9". |
| Archive ops batch | `setPanelPhase(archivePhaseLbl)` sin "Paso 8/9". |
| SOLO_PN: mapa y precios | Sin "Paso 1/5" ni "Paso 2/5". |

Adicional: dentro del chunk loop el `SaveManyPNP` batches, `SaveQuoteLines` por PN y `GetQuote` ejecutaban sin `setPanelSubPhase` — operador no veía progreso intra-chunk. STEP 7 (Racks) tampoco mostraba progreso de batches ni del delete loop.

### Fix
- **Consolidar setPanelPhase**: cada paso ahora tiene UNA sola llamada con prefix "Paso N/9" (o "Paso N/5" en SOLO_PN). Las llamadas redundantes que borraban el prefix se eliminaron.
- **Pasos antes mudos numerados**: Paso 3/9 (chunk loop), Paso 6a/9 (predictivos), Paso 6b/9 (sync params), Paso 8a/9 (releyendo precios). SOLO_PN: Paso 1/5 (mapa) y Paso 2/5 (precios standalone).
- **SubPhase en sub-fases del chunk loop**: SaveManyPNP batches (`batch N/M`), GetQuote (`leyendo quote para reconstruir lookup`), SaveQuoteLines (`aplicando productos a líneas`), reconstrucción de chunks ya completados (`Reanudando chunk N/M`).
- **Progress visible en STEP 7 racks**: subPhase + setPanelProgress por batch de 50 racks; subPhase por PN en delete loop.
- **PanelProgress global**: el modal muestra una barra de progreso en cada uno de los pasos numerados, no solo el bar lateral.

### Lección
- **Una fase = un setPanelPhase**. Cuando hay dos llamadas seguidas, la última gana — si solo la primera tiene el prefix de paso, el prefix se pierde. Patrón a evitar: `setPanelPhase('Paso N/9: ...')` seguido inmediatamente de `setPanelPhase('detalle sin prefix')`.
- **Sub-fases necesitan setPanelSubPhase**, no setPanelPhase. La distinción es importante: `setPanelPhase` clava el nombre del paso (visible toda la duración), `setPanelSubPhase` es la línea inferior que rota. Re-usar setPanelPhase para "detalle" mata la jerarquía visual.
- **Cada loop interno con N iteraciones debe llamar setPanelProgress o setPanelSubPhase al menos por iteración**. Si no, el operador ve UI congelada aunque el código avance correctamente — fuente recurrente de soporte ("¿está atorado?").

### Plan de validación
- [ ] Run con CSV ≥ 3000 PNs con resume tras crash: verificar que el modal muestra "Paso 3/9: Creando/reanudando cotizaciones (15)" durante el chunk loop y avanza 1..15.
- [ ] STEP 6a (Predictivos): si la corrida tiene predictivos, modal debe mostrar "Paso 6a/9" con progreso n/total.
- [ ] STEP 6b: modal muestra "Paso 6b/9" con progreso visible.
- [ ] STEP 7 (Racks): si hay racks, modal muestra "Paso 7/9: Racks..." + subPhase "Racks batch N/M (50 racks)" cada 50 items.
- [ ] STEP 8 (Archive): modal muestra "Paso 8/9: Archivando X / Desarchivando Y (pool Z)" — no se borra el prefix.

### Pendientes derivados
- [ ] La numeración tiene huecos (1, 2, 3, 4.5, 5, 6, 6a, 6b, 7, 8). Renumerar a secuencia lineal en una corrida futura, o aceptar que los .5/a/b reflejan sub-pasos opcionales. Por ahora la prioridad es que cada paso hable.
- [ ] No hay "Paso 9/9" explícito — al terminar pone directamente "Completado.". Considerar agregar "Paso 9/9: Finalizando..." para simetría visual.

## 1.4.24: persistir progreso de STEP 6b + latch en stop Datadog + liberar cache por PN (Fix EE, 2026-05-23)

### Síntoma
Tras 1.4.23 (fast-path corregido), el resume saltaba bien `classifyPNs` pero **STEP 6b (`Sync params spec en PNs existentes`) volvía a empezar desde 0 en cada reanudación**. Run de 3692 PNs en CSV Schneider: cancel a 691/3692 → reload → resume → STEP 6b vuelve a 0/3692. Cada ciclo: ~691 PNs procesados, OOM, reload, otros ~691, OOM, … El operador reportó: "este paso es el que se atora, pero vuelve a empezar desde el inicio siempre, no podemos hacer algo?". Adicional: log de consola saturado con `[SA] Datadog: stopSessionReplay …` (40+ líneas seguidas) — cada tick del `memoryGauge` (cada 2s) cuando `pct >= 70` invocaba la función completa otra vez.

### Diagnóstico
1. **STEP 6b sin persistencia**: el loop `runPool(step6bCandidates, step6bWorker, syncConcurrency)` no marcaba PNs como completados en `resumeState`. STEP 6 (enrich) sí lo hace (`completedPNs.push(rkey)` cada 50), pero 6b nunca lo replicó. El operador veía progreso visual pero al recargar, el set vacío reiniciaba todo. Multiplicado por la presión OOM (cada PN fetchea `GetPartNumber` ~25KB + Apollo cache lo retiene por `__typename` normalization) → ciclo infinito.
2. **`stopDatadogSessionReplay` sin idempotencia real**: aunque tenía guards internos por API (`if (DD_RUM?.stopSession)`), las funciones se podían llamar todas en cada invocación; lo crítico era el `log()` por cada layer y los monkey-patches que se re-aplicaban. Cada llamada extra agregaba al menos 4-5 entries a `_log` → `_persist()` re-serializaba el array completo a `localStorage` → quota churn + GC pressure.
3. **`existingPnFullCache` sin liberación por PN en STEP 6b**: cada `pnNode` (~25KB) quedaba retenido hasta el `clear()` post-STEP 6b. Para 3692 PNs son ~92MB acumulados solo en pnNodes, sin contar overhead Apollo. Si el run truena a mitad, esos buffers nunca se liberan.

### Fix
1. **Persistencia STEP 6b (Fix EE)**:
   ```js
   // Init resumeState (fresh-run):
   syncParamsCompletedPNs: [],
   // Hidratación pre-1.4.24:
   if (!Array.isArray(resumeState.syncParamsCompletedPNs)) resumeState.syncParamsCompletedPNs = [];
   // Set en memoria:
   const syncParamsCompletedSet = new Set(resumeState?.syncParamsCompletedPNs || []);
   // Skip al inicio del worker:
   const rkey = `${i}|${part.pn}|${part.customerId}`;
   if (syncParamsCompletedSet.has(rkey)) return;
   // Persist al final solo si no hubo error, cada 50:
   if (!workerError && resumeState) {
     resumeState.syncParamsCompletedPNs.push(rkey);
     syncParamsCompletedSet.add(rkey);
     if (resumeState.syncParamsCompletedPNs.length % 50 === 0) persistResumeState();
   }
   ```
2. **Latch Datadog**: flag `window.__sa_dd_stopped` — la primera llamada hace todo el trabajo y lo setea; subsecuentes hacen solo cleanup mínimo de Apollo (`clearStore()` / `cache.reset()`) y vuelven. Cero ruido en consola/localStorage.
3. **`existingPnFullCache.delete(entry.pn.id)` en `finally` del step6bWorker**: cada PN libera su buffer al terminar (OK o error). El `clear()` final post-STEP 6b queda como red de seguridad.

### Lección
- **Toda fase con cardinalidad alta + costo memoria por iteración debe persistir progreso**. STEP 5 (sentinels) lo aprendió en 1.4.8. STEP 6 (enrich) lo tiene desde el inicio. STEP 6b se omitió porque era "rápido" en runs chicos — pero para 3000+ PNs con Apollo cache leak, se vuelve la fase OOM-prone número 1.
- **Cualquier función que se invoque desde un tick (interval, gauge, etc.) necesita latch idempotente real, no solo guards condicionales**. Cada llamada que toca un singleton (`_log`, `localStorage`) tiene costo amortizado y a 0.5Hz se acumula.
- **Buffers retenidos por toda la fase = ~N × tamaño_buffer × MB**. Liberar por iteración (delete in finally) divide el peak por N. Aquí: 3692 × 25KB ≈ 92MB → 25KB.

### Plan de validación
- [ ] Run de 3000+ PNs: cancelar mid-STEP-6b a ~500/3000, recargar, reanudar; verificar que la barra parte de ~500 (no 0) y que el log incluye `Reanudando corrida previa — fase: …` con `syncParamsCompletedPNs.length` reflejado.
- [ ] Consola libre del spam `[SA] Datadog: stopSessionReplay …` después del primer tick que cruza 70%.
- [ ] `performance.memory.usedJSHeapSize` durante STEP 6b se mantiene plana (delta < 200MB sobre 1000 PNs), no creciente lineal.

### Pendientes derivados
- [ ] Aplicar el mismo patrón de persistencia a STEP 7 (Racks) y STEP 8 (default price + archive) si crashes muestran que también re-arrancan desde 0.
- [ ] Throttle de `_persist()` en `steelhead-api.js` (cap del `_log` a últimas N líneas + `persistResumeState`-style debounce). Hoy se serializa el array completo en cada `log()`.
- [ ] Considerar bajar `concurrency.savePartNumber` de 8 a 3 para STEP 6b si OOM persiste — los 8 workers concurrentes fetchean 8 × `GetPartNumber` simultáneos, multiplicando el peak instantáneo.

## 1.4.23: fix fast-path de resume — comparar pn|customerId, no csvRowKey inexistente (Fix DD, 2026-05-23)

### Síntoma
Aunque 1.4.21/22 introdujeron el fast-path para saltar `classifyPNs` en resume, **el fast-path nunca se aplicaba**: cada reanudación volvía a correr el prefetch global (~1.7GB baseline) y la barra mostraba "Clasificación: evaluando 3692 filas" + "24408/24408" otra vez. Causa observada en sesión 2026-05-23 cuando el applet quedó atascado re-clasificando tras un cancel del STEP 6b a 3550/3692.

### Diagnóstico
La condición `c.csvRowKey === parts[i].csvRowKey` evaluaba a `false` siempre, porque **`parts[i].csvRowKey` siempre es `undefined`**. El campo `csvRowKey` solo existe en el shape de `pnStatus` (poblado en `classifyOnePN` línea 1379 con la fórmula `${p.pn.toUpperCase()}|${p.customerId}`), nunca en el shape de `parts` (output de `parseRows()`). El fast-path nunca aplicaba → cada resume re-corre classifyPNs completo.

### Fix
Reconstruir el key esperado desde `parts[i]` con la misma fórmula:

```js
const expectedKey = `${(parts[i].pn || '').toUpperCase()}|${parts[i].customerId}`;
return c && c.csvRowKey === expectedKey && /* … */;
```

### Lección
- **Fast-paths sobre objetos con shapes asimétricos requieren reconstruir el comparador, no asumir simetría**. `parts` y `pnStatus` son arrays paralelos por índice pero con campos distintos — `pn` está en ambos, `csvRowKey` solo en uno. La validación correcta es comparar contra una reconstrucción determinística desde el lado fuente, no contra una propiedad que no se hereda.
- **Code review post-deploy con telemetría real**: el bug pasó dos deploys (1.4.21, 1.4.22) porque ningún log delataba el branch tomado (`canSkipPrefetch === true/false`). Falta agregar un `log()` discriminante de cuál branch se tomó (ya existe el "Resume detectado..." pero solo se imprime en `true`, no en `false`).

### Plan de validación
- [ ] Run con CSV ≥ 3000 PNs: cancelar mid-STEP-6b, recargar, reanudar; verificar log `Resume detectado con classifications completas — saltando prefetch global (ahorro ~1.7GB baseline).`
- [ ] Memoria del segundo arranque < 500MB durante toda la fase de classify (porque ya no hay prefetch).
- [ ] Resume llega a STEP donde quedó sin re-procesar PNs ya completados.



## 1.4.21: skip prefetch en resume + STEP 5 marca skips + XHR patch + Apollo cleanup (Fix CC v3, 2026-05-23)

### Síntoma
Con 1.4.20, guardrail dispara correctamente al 88% pero **cada reanudación procesa muy pocos PNs nuevos**. Ciclos de ~5 min (reload → prefetch → STEP 5 → 88% → guardrail → repeat) prácticamente sin progreso. El resume marcaba sólo 72 sentinels "saltados" aunque la barra mostrara `1908/3281`. La memoria seguía creciendo a ~1.12 MB/PN.

### Diagnóstico
Tres problemas amplifican el OOM:

1. **Prefetch global se re-ejecuta cada reanudación**: `classifyPNsMassive` (línea 1176) llama `prefetchPNsByCustomer` que carga ~22k PNs activos + ~24k archivados a memoria → baseline ~1.7GB antes de procesar nada. Como el resume re-corre `classifyPNs` desde cero, cada ciclo paga esa cuenta.
2. **STEP 5 skip sin persistencia** (línea 3406): `if (!archiveIds.length) { sentinelSkip++; return; }` no marcaba el PN en `archivedSentinelsPreQuote`. Sólo los OK reales se guardaban. Los miles de PNs ya limpios (sin specs sentinel vigentes) se re-procesaban en cada resume → `GetPartNumber` por cada uno (~25KB response) → memoria crece sin trabajo útil.
3. **Apollo Client de Steelhead acumula responses**: heap snapshot mostraba `Station`/`WorkboardsConnection`/`StationParametersConnection` `__typename` creciendo 3.5× entre snapshots. El cliente Apollo del SPA normaliza TODOS los responses por `__typename + id` en `InMemoryCache`. Nuestro stop de Datadog no toca esto.

### Fix
- **Fast-path en resume — saltar `classifyPNs` (opción B real)**: antes de llamar `checkPNExistence` (línea 2936), verificar si `resumeState.classifications` ya cubre los `parts` con `classification != null` y `existingProcessId` poblado. Si sí, reconstruir `pnStatus` desde el resume directamente sin tocar la red. Baseline cae de ~1.7GB → ~400MB en cada reanudación.
- **Persistir `existingProcessId` en classifications** (línea ~2984): necesario para el fast-path. Migración suave — runs viejos sin este campo caen al classifyPNs completo, después de ese pase ya tienen el shape nuevo.
- **STEP 5 skip marca como done** (línea 3406): tanto `sentinelOk` como `sentinelSkip` ahora `push(target.pnId)` al buffer. La próxima reanudación los salta sin llamar `GetPartNumber`.
- **Patch XHR** (`stopDatadogSessionReplay`): además de fetch+sendBeacon, monkeypatch `XMLHttpRequest.prototype.open/send` para abortar requests a `browser-intake-ddog-gov.com` / `datadoghq.com`.
- **Intento de Apollo cleanup**: tras cada disparo, probar `window.__APOLLO_CLIENT__ / window.apolloClient / window.__APOLLO__.client`. Si alguno existe, llamar `clearStore()` o `cache.reset()`. La build de Steelhead no lo expone por defecto, pero si una versión futura lo hace, este código aprovecha sin nuevo deploy.

### Lección
- **El resume debe minimizar la pre-fase de cada reanudación**: si la fase A ya terminó en una corrida previa, la próxima no debería re-ejecutarla. Antes confiábamos en que classifyPNs era barato; con CSVs >3k filas el prefetch global mete 1.7GB que el navegador no libera entre fases. El fast-path corta la dependencia.
- **Marcar "ya procesado" debe incluir todos los terminales** (OK, skip por idempotencia). Un skip por "ya está limpio" es semánticamente equivalente a OK para efectos de resume.

### Pendientes
- Validar 1.4.21 con run de 7000 PNs (mismo cliente). El primer resume desde 1.4.20 aún hará classifyPNs (porque el resume actual no tiene `existingProcessId`); del segundo en adelante salta el prefetch.
- Si STEP 5/6b siguen creciendo aunque el baseline baje, el leak residual es Apollo Client — siguiente fase: explorar hook de Apollo devtools o session segmentada por chunks.

## 1.4.20: stop Datadog agresivo + guardrail OOM (Fix CC v2, 2026-05-23)

### Síntoma
1.4.19 con `stopSessionReplayRecording()` no aguantó. Validación 04:00: run de 3692 PNs en STEP 6b llegó a 2724 MB. Tras stop manual, memoria SIGUIÓ creciendo ~43 MB/min (vs ~50 sin stop). Crash por OOM a 93% antes de terminar el step.

### Diagnóstico
El SDK de Datadog mantiene observers de DOM activos aunque el flag de `stopSessionReplayRecording` esté en "stopped". El buffer en RAM sigue creciendo con cada DOM mutation. Si el envío al endpoint Datadog falla, el SDK puede acumular eventos en buffer esperando retry.

### Fix
Tres capas defensivas:

1. **Stop multi-API** en `stopDatadogSessionReplay()`: `stopSessionReplayRecording()` + `stopSession()` + `setTrackingConsent('not-granted')`.

2. **Monkey-patch** de `window.fetch` y `navigator.sendBeacon`: descarta requests a `browser-intake-ddog-gov.com` / `datadoghq.com` con 204. Aunque el SDK siga grabando, no logra enviar ni acumular retries.

3. **Guardrail anti-OOM**: el memory gauge tick (cada 2s) re-aplica el stop a >70% y dispara `triggerMemoryGuardrail()` a >88%, que persiste resume + `cancelRun()` + muestra modal "Recarga la tab para reanudar". Convierte un crash impredecible en checkpoint limpio.

### Lección
- `stopSessionReplayRecording()` por sí solo NO libera memoria — el SDK solo marca un flag, los observers DOM siguen activos.
- Para SDKs third-party que leakean, defensa robusta = bloqueo del endpoint vía monkey-patch + guardrail con checkpoint.
- En runs > 2 hrs, asumir que algo va a leakear y diseñar para checkpoints frecuentes.

### Pendientes
- Validar 1.4.20 con run > 3000 PNs sin intervención manual.
- Si tras guardrail el reload no es suficiente, evaluar partir CSV en chunks de 1500.

## 1.4.19: stop Datadog Session Replay (Fix CC, 2026-05-23)

### Síntoma
Runs largos (3281 PNs) crecían linealmente ~1.2 MB/PN. Heap iba de 553 → 952 → 1218 → 2076 MB en corridas sucesivas. Crash por OOM antes de terminar.

### Diagnóstico (heap snapshots)
Dos snapshots tomados con ~20 min de delta (1.4 GB → 2.9 GB). `JSON.stringify(__state)` solo daba ~9 MB → los retainers no estaban en el state visible. Análisis con `tools/analyze-heap.js`:

| `__typename` | Snap 1 | Snap 2 | × |
|---|---|---|---|
| `StationParametersConnection` | 448K | 1.55M | 3.5× |
| `WorkboardCardsConnection` | 458K | 1.59M | 3.5× |
| `WorkboardsConnection` | 448K | 1.55M | 3.5× |
| `Station` | 710K | 2.21M | 3.1× |

Counts no correspondían a objetos de bulk-upload (que usa `fetch` directo, no Apollo). Inspección de Network reveló: Datadog RUM SDK con `session_replay_sample_rate: 100` corriendo en `app.gosteelhead.com` graba TODA respuesta de fetch (incluidas las del bulk-upload) en buffer para enviar como replay. Cada `GetPartNumber`/`SaveQuote` retorna ~700 objetos anidados — multiplicado por 3281 PNs ≈ 2.3M objetos. Cuadra exacto con los counts observados.

Tras `Cmd+Shift+R` + `DD_RUM.stopSessionReplayRecording()`: heap se quedó estable. Snapshot post-fix mostró `WorkboardsConnection` desaparecido del top y crecimiento ~3 MB/min (vs ~50 MB/min antes) — el residual cabe en el límite de 4GB para runs nocturnos.

### Fix
Nueva función `stopDatadogSessionReplay()` que busca `window.DD_RUM`/`datadogRum`/`__DD_RUM__` y llama a `stopSessionReplayRecording()` defensivamente (no rompe si la API cambia). Se invoca al inicio de `execute()` justo después de `showPanel()`. Se re-ejecuta en cada execute() porque tras crash + resume el cleanup debe reaplicarse.

### Lección
- En apps host con Datadog/Sentry/LogRocket, `session_replay_sample_rate: 100` es incompatible con automatizaciones que generan miles de fetch en una sesión. Buscar y desactivar al iniciar.
- Heap snapshots > `__state` diagnostics cuando el leak está en globals que la app inyecta.
- `tools/analyze-heap.js` parsea snapshots > 1 GB en streaming sin requerir DevTools UI.

### Pendientes
- Validar que el run de 3281 PNs termina sin OOM con 1.4.19 deployado.
- Considerar parametrizar el stop por config (algunos clientes podrían querer mantener replay activo en runs cortos).

## 1.4.18: showResult inmune al churn React de Steelhead (Fix BB, 2026-05-23)

### Síntoma
Corrida diferencial de 2017 PNs SOLO_PN completó todo el pipeline (Racks 2015, Default Price 2020, etc.) y al renderizar el modal final el outer catch capturó:

```
FATAL: Cannot set properties of null (setting 'onclick')
```

Stats arriba del error mostraban todos los pasos llenos — el pipeline era correcto; el bug estaba en el modal de resultado.

### Diagnóstico
Las únicas asignaciones `.onclick` sin try/catch en el path post-pipeline (después de `setPanelPhase('Completado.')`) viven en `showResult()` líneas 2419-2420 (versiones ≤1.4.17):

```js
document.getElementById('dl9-close').onclick = () => removeOverlay(overlay);
document.getElementById('dl9-copy-log').onclick = () => { ... };
```

El resto de modales del archivo usan `modal.querySelector(...)` (preview, conflict, resume, pagination — todos funcionan sin error). `showResult` era el outlier que escaneaba el `document` global. Cuando el árbol React de Steelhead re-reconcilia durante la corrida larga (el modal vive 100+ms hasta que el usuario lo cierra), `getElementById` puede devolver `null` para ids recién insertados aunque el nodo siga vivo dentro de `modal`.

### Fix BB
- Cambiar `document.getElementById('dl9-close' | 'dl9-copy-log' | 'dl9-open-quote')` → `modal.querySelector('#...')` en `showResult()`.
- Agregar null guards con `warn(...)` para visibilidad si Steelhead llegara a desreferenciar el botón aún dentro del modal.
- `modal` es el nodo que acabamos de crear en `createOverlay()` — está aislado del churn externo.

Otros modales (showQuoteConflict líneas 2304-2306) usan el mismo patrón `document.getElementById` pero se descartan al instante (resolve dentro del onclick), así que no son vulnerables al mismo timing. Quedan como están para no inflar el cambio.

### Plan de validación
- Correr una carga SOLO_PN diferencial de ~2k PNs y verificar que el modal final aparezca sin `FATAL: Cannot set properties of null` aunque haya errores acumulados.
- Si aparece algún `warn('showResult: #... no encontrado en modal.')` en la consola, abrir issue: el churn React llegó hasta el modal interno y necesitamos reaplicar el innerHTML.

### Pendientes derivados
- Considerar generalizar el patrón: cualquier modal nuevo debe usar `modal.querySelector` en vez de `document.getElementById` (regla del playbook DOM).

## 1.4.13: fix `quotePnIds` no definida + rename Archivado/Desarchivado + fix `resumeState` false-completed (Fixes X+Y, 2026-05-22)

Tres bugs encontrados en post-mortem de la corrida 1.4.11 de 4270 P1 con red intermitente (416 errores). Stats finales habían reportado `Labels: 0, Specs: 0` y el listado de Steelhead mostraba bloques de PNs sin labels/specs intercalados con bloques OK.

### Fix X1 — `Precios standalone: ReferenceError: quotePnIds is not defined` (~200 errores)

En el batch de precios standalone del modo `SOLO_PN` (línea 3641), el log de sub-phase referenciaba `quotePnIds.length` para calcular `totalBatches`. Pero `quotePnIds` solo existe en la rama con cotización; en SOLO_PN el iterable es `pnpWithPrice`. El ReferenceError saltaba al `catch` que tragaba toda la llamada `SaveManyPNP_PN`. Resultado: cero precios standalone guardados en SOLO_PN aunque `Default Price: 4182` sí entrara (eso viene de STEP 8 releyendo del PN, no de SaveManyPNP).

```diff
- const totalBatches = Math.ceil(quotePnIds.length / 20);
+ const totalBatches = Math.ceil(pnpWithPrice.length / 20);
```

### Fix X2 — panel "Paso 5/5: Archivado..." engañoso

En rondas de activos el STEP 8 mayoritariamente DESARCHIVA PNs (no archiva). El panel decía solo "Archivado..." sin distinguir, generando confusión razonable ("¿por qué archiva si esta ronda es de activos?"). Cambios:

- `setPanelPhase` de STEP 8: `'Paso 5/5: Archivado...'` → `'Paso 5/5: Archivado / Desarchivado...'`.
- Phase line del pool: `'Archivando PNs (pool 8)'` → `'Archivando N / Desarchivando M (pool 8)'` (línea 4560), con desglose visible en tiempo real.

El log txt ya tenía el desglose desde 1.4.8 (`Archivado: X nuevos archivar, Y viejos archivar, Z desarchivar`), solo faltaba reflejarlo en el panel.

### Fix Y — `resumeState.completedPNs` marcaba false-completed (CRÍTICO)

**Síntoma reportado por el usuario:** después de 2 corridas (la primera atorada, la segunda como reanudación), el listado "Created At Descending" de Part Numbers en Steelhead mostraba bloques de PNs vacíos (sin labels, sin spec params) intercalados con bloques con todos los datos. PNs con múltiples rowIdx en el CSV (forceDup) tenían unas entradas OK y otras vacías. Stats de la segunda corrida: `Enrich: 4270 OK, 0 retry` pero `Labels: 0, Specs: 0` — todo brincado por resume.

**Root cause (líneas 4039-4047 pre-1.4.13):**

```js
// Pre-1.4.13: marcaba incondicionalmente
const rkey = `${idx}|${part.pn}|${part.customerId}`;
if ((okSP + retrySP) % 50 === 0 && resumeState) {
  resumeState.completedPNs.push(rkey);
  persistResumeState().catch(() => {});
} else if (resumeState) {
  resumeState.completedPNs.push(rkey);
}
```

El bloque corre **al final del `enrichWorker`** sin distinguir si `SavePartNumber` tuvo éxito o cayó al `errors.push` del catch en línea 4034 (Failed to fetch tras 3 retries no es retry-able y no hace `throw`, solo `errors.push + counters.errors++`). Resultado: cada PN que falló por red intermitente quedaba marcado en `completedPNs` de localStorage. La siguiente corrida lo brincaba en línea 3729 (`if (resumeCompletedSet.has(resumeKey)) { okSP++; return; }`) sin ni siquiera intentar labels o specs.

**Cadena de eventos en la corrida del usuario:**
1. Corrida #1 (~50% del CSV procesado en STEP 6 enrich, red intermitente). N PNs cayeron a `Failed to fetch` después de los 3 retries de `withRetry`. Quedaron marcados como completed-falsos en localStorage.
2. Usuario detuvo. Reanudó.
3. Corrida #2 (la del log con 416 errores). En enrich: brincó los 4270 PNs por `resumeCompletedSet`. Stats `Labels: 0, Specs: 0`. STEP 8 desarchivó OK los 4267 existentes. STEP 6b (params) y STEP 7 (racks) sí corrieron (no usan el mismo gate de resumeCompletedSet) — esos sí dejaron errores nuevos en el log (`AddParams ... Failed to fetch`, `SavePartNumberRackTypes ... Failed to fetch`).
4. Estado final en Steelhead: PNs creados/desarchivados pero **algunos sin labels ni specs** (los que cayeron en paso 1).

**Fix Y:** introducir flag local `pnSucceeded`. Setearlo a `true` en los 3 success paths (línea 3996 `okSP++`, línea 4015 `retrySP++` strip1, línea 4025 `retrySP++` strip2). El bloque de persistencia ahora chequea `if (pnSucceeded && resumeState)` antes de pushear el rkey. Un PN que falló queda fuera de `completedPNs` y se reintentará en la próxima reanudación.

```diff
+ let pnSucceeded = false;
  try {
    await withRetry(() => api().query('SavePartNumber', { input: [pnInput] }), ...);
-   okSP++; state.counters.ok++;
+   okSP++; state.counters.ok++; pnSucceeded = true;
    if (pn.id) existingPnFullCache.delete(pn.id);
  } catch (e) {
    // ...strip1...
+   pnSucceeded = true;  // en éxito
    // ...strip2...
+   pnSucceeded = true;  // en éxito
    // else: errors.push (pnSucceeded queda false)
  }

- const rkey = `${idx}|${part.pn}|${part.customerId}`;
- if ((okSP + retrySP) % 50 === 0 && resumeState) {
-   resumeState.completedPNs.push(rkey);
-   persistResumeState().catch(() => {});
- } else if (resumeState) {
-   resumeState.completedPNs.push(rkey);
- }
+ if (pnSucceeded && resumeState) {
+   const rkey = `${idx}|${part.pn}|${part.customerId}`;
+   resumeState.completedPNs.push(rkey);
+   if ((okSP + retrySP) % 50 === 0) persistResumeState().catch(() => {});
+ }
```

### Recuperación de los 4267 PNs corruptos

El fix Y previene daño futuro pero los PNs ya marcados false-completed no se auto-arreglan. Approach acordado con el usuario: generar un CSV de recuperación que incluya solo los PNs que en Steelhead quedaron sin labels o sin spec params, y volverlos a meter con bulk-upload normal. Como los PNs ya existen, el matcher debería identificarlos como `existing` y el enrich los actualizará. Pendiente: script de auditoría que detecte PNs incompletos vía GraphQL y derive el subset del CSV.

### Validación pendiente

- [ ] Smoke run con red flaky simulada (DevTools throttling "Offline" durante 2-3 batches del enrich): los PNs fallidos NO deben quedar en `resumeState.completedPNs`. Al reanudar deben reintentarse.
- [ ] Run completo del CSV de recuperación (subset de los 4267 corruptos): después de la corrida, todos deben tener labels + specs visibles en Steelhead.
- [ ] Verificar que la phase line del STEP 8 muestra el desglose `Archivando N / Desarchivando M`.
- [ ] Verificar que SaveManyPNP_PN en SOLO_PN ya no tira ReferenceError (smoke en CSV con `precio` poblado).

### Pendientes derivados

- 1.4.14: script/applet de auditoría que detecte PNs incompletos en Steelhead (sin labels o sin spec params después de bulk-upload) y exporte un CSV ya filtrado, en vez de que el operador tenga que armarlo a mano.
- 1.4.14: considerar también gatear el push en `resumeState.identifierEnrichDone` (Call A) por la misma razón — actualmente se marca después de cada Save\* sin distinguir el éxito.

---

## 1.4.12: feedback en silent loops del pre-enrich + paralelización del pre-fetch de predictivos (Fix W, 2026-05-22)

**Contexto.** En 1.4.11 con corrida masiva (4270 P1 existing de Clientes Generales) el panel se quedó visualmente "atorado" en `Paso 3/5: Enriqueciendo PNs... 24364/24364 OK: 0  [HH:MM:SS] 3 PNs creados` durante ~15-35 minutos sin avance visible. La consola y DevTools Network confirmaban que sí estaba procesando — puros `GetPartNumber` secuenciales — pero el panel no reflejaba nada.

### Problema raíz

Entre `setPanelPhase('Paso 3/5: Enriqueciendo PNs...')` (línea ~3612) y el inicio del runPool de `enrichWorker` (línea ~3641) hay un loop **secuencial** (líneas 3617-3633) que pre-fetcha `predictedInventoryUsages` de cada PN existing con `predictiveUsage` desde el CSV. Ese loop:

1. NO tiene `bailIfStale` — "Detener" no lo detiene.
2. NO tiene `setPanelSubPhase` ni `setPanelProgress` — los `24364/24364` visibles son **residuales** del scan de archivados (línea 938: `setPanelProgress(scannedArch, ...)`).
3. NO consulta `resumeCompletedSet` — refetcha incluso para PNs ya enriquecidos en una corrida previa.
4. Es secuencial sin runPool — 4270 × ~0.3-0.5s = 15-35 min.

Auditoría reveló más loops `for await` silenciosos en la fase pre-STEP: customer prep (`uniqueClientNames`), process names (`uniqueProcessNames`), dim ids (`Object.values(dimIds)`), spec fields cache (`uniqueSpecs`).

### Fix W: feedback consistente + paralelización del pre-fetch crítico

**Pre-fetch predictivos (líneas 3617-3673):**
1. Skip por `resumeCompletedSet` — en reanudación, los PNs ya enriquecidos no necesitan refetch (su predictivo no se va a re-aplicar). Loggea `Pre-fetch predictivos: N PN(s) saltados (ya enriquecidos en corrida previa)`.
2. `runPool` concurrency = `bulkCfg().concurrency.savePartNumber` (8 por default) → 15-35 min → 2-5 min.
3. `setPanelPhase('Pre-fetch predictivos existentes (N)')` + `setPanelSubPhase('Pre-fetch predictivos: <name>')` + `setPanelProgress(done, total)` + `bailIfStale`.

**Customer prep (líneas 2555-2585):** `setPanelPhase('Resolviendo clientes (N)')` + `setPanelSubPhase('Cliente: <cname>')` + `setPanelProgress(done, total)`.

**Process names (líneas 2655-2673):** `setPanelPhase('Resolviendo procesos (N)')` + `setPanelSubPhase('Proceso: <pname>')` + `setPanelProgress(done, total)`.

**Dim ids (líneas 2701-2722):** `setPanelPhase('Cargando dimensiones contables (N)')` + `setPanelSubPhase('Dimensión: <key>')` + `setPanelProgress(done, total)`.

**Spec fields cache (líneas 2727-2755):** `setPanelPhase('Cargando definiciones de specs (N)')` + `setPanelSubPhase('Spec: <sn>')` + `setPanelProgress(done, total)`. El log existente `Spec "X": N campos` se conserva.

### Validación pendiente

- [ ] Smoke run en CSV chico (1 cliente, 10 PNs nuevos): panel transiciona por cada sub-fase con texto y progress bar moviéndose.
- [ ] Run Clientes Generales (4270 P1): el "Paso 3/5: Enriqueciendo PNs..." ahora intercala una sub-fase `Pre-fetch predictivos existentes (N)` con progress bar antes de entrar al enrich real. En reanudación, debe loggear `N PN(s) saltados (ya enriquecidos)` y el pre-fetch debe ser casi instantáneo.
- [ ] Validar que `Detener` durante cualquiera de las nuevas sub-fases corta inmediatamente (todas tienen `bailIfStale`).

### Pendientes derivados

- 1.4.13 (opcional): otras zonas con `addPanelLog` muy ruidoso (ej. `Precios batch X/Y`) ya están agrupadas vía `setPanelSubPhase` desde 1.4.10; auditar si hay residuales.
- 1.4.13 (opcional): considerar **borrar** los entries de `resumeState.identifierEnrichDone` cuyo `rowKey` ya está en `completedPNs` (cleanup periódico para no inflar el JSON al reanudar).

---

## 1.4.11: STEP 6 Split A/B (anti-duplicados al reanudar) + concurrencia 8 + medidor de memoria (Fix V, 2026-05-22)

**Contexto.** Después de los crashes OOM de 1.4.7/1.4.8/1.4.9, al reanudar corridas masivas se observaron PNs duplicados creados en lugar de matcheados. Caso concreto: corrida Schneider que tronó a ~4795/4799 PNs en STEP 6b dejó **58 PNs duplicados** al reanudar — `classifyPNs` no encontraba el PN existente porque la corrida anterior no alcanzó a commitear los identificadores (labels, BaseMetal, QuoteIBMS) antes del crash. Los pases 1/2 de `classifyOnePN` que matchean por QuoteIBMS + BaseMetal + labels fallaban y el row caía a `forceNew`.

### Problema raíz

`enrichWorker` hacía UN solo `SavePartNumber` por PN con TODO de una vez: `labels + customInputs (BaseMetal, QuoteIBMS) + specs + params + dims + archive + processNode`. Si truena después de classifyPNs pero antes de que el SavePartNumber commitee, al reanudar `classifyPNs` ve el PN existente "pelón" (sin labels, sin BaseMetal, sin QuoteIBMS) → ningún pase del matcher encuentra el PN → `forceNew` → duplicado.

### Fix: Split A/B en enrichWorker

**Call A (identificadores, barata ~0.3-0.5s):** `SavePartNumber` con `name + customerId + labelIds + customInputs (BaseMetal+QuoteIBMS) + inputSchemaId` + arrays vacíos para todo lo pesado. Tras éxito, rowKey `${idx}|${pn}|${customerId}` se persiste en `resumeState.identifierEnrichDone[]` con flush incremental cada 50.

**Call B (todo lo pesado, sin cambios):** el `pnInput` actual con specs/params/dims/archive/processNode/predictive. Sigue marcando `completedPNs` al final.

Si truena entre A y B: el siguiente resume corre `classifyPNs` sobre un catálogo donde el PN existente YA tiene labels + BaseMetal + QuoteIBMS frescos. `extractPNShape` (línea ~950) lee esos campos del response de `AllPartNumbers`, los pases 1/2 del matcher detectan el duplicado y lo asignan como `existing` en vez de `forceNew`.

Si Call A falla (caso raro): NO se marca `identifierEnrichDone`, Call B intenta igual con el pnInput completo. Si B acepta, el PN queda enriched. Si B también falla, error queda registrado y no se marca completedPNs.

### Coste

- +1 `SavePartNumber` round-trip por PN (~0.3-0.5s).
- Compensado por bump de concurrency `savePartNumber: 5 → 8` y `archive: 5 → 8` en `config.json` — Steelhead aguanta 8 sin 429.
- Neto estimado en run de 7k PNs: **–10 a –15 min** wall-clock comparado con 1.4.10.

### Cambios adicionales

1. **Concurrency bump 5→8** en `bulkUpload.concurrency.savePartNumber` y `archive`. `sentinelPreQuoteArchive: 3` se mantiene (ya tronó a 5 por buffers GraphQL en runs >3k).

2. **Medidor de memoria en panel** — `performance.memory.usedJSHeapSize` reportado en el header del panel cada 2s. Formato `Mem: 234MB / 4096MB (5%)`. Color cambia a ámbar a >70% del límite, rojo a >85%. Polling es lectura nativa, cero costo medible. Sin `performance.memory` (Firefox/Safari) el span queda en blanco. Diagnóstico in-line del riesgo de OOM antes de que tronara.

### Por qué NO se paralelizaron STEP 4.5 || STEP 5 y STEP 7 || STEP 8

Refactor invasivo (los bloques están estructuralmente entrelazados con STEP 1 y STEP 7b/8 default-price) para ganancia marginal (~5 min en runs de 7k PNs). El bump de concurrency 5→8 ya entrega el grueso del ahorro (–25%). Diferido a 1.4.12 si tras validar 1.4.11 vale la pena.

### Plan de validación pendiente

- [ ] Reanudar el run de Clientes Generales (resumeKey `17fc5ef8...`, phase `enrich-done`, ~4270 PNs) y confirmar `Reanudando corrida previa — N PNs ya completados, M con identificadores commiteados`.
- [ ] Run fresh de Schneider: verificar que Call A loguea OK (sin warns "SavePartNumber-A falló") y que NO crea duplicados al reanudar tras un crash forzado (matar el tab a mitad de STEP 6).
- [ ] Concurrency 8 sin 429s: confirmar que Steelhead no devuelve `Too Many Requests` ni `503` durante STEP 6 / STEP 6b / STEP 8.
- [ ] Medidor de memoria: confirmar que el header del panel muestra `Mem: X MB / Y MB (Z%)` y que el color cambia a ámbar/rojo si la memoria sube.
- [ ] Auditar catálogo post-run con el snippet de PN dups por (name|customerId) — el conteo debe ser menor que el de 1.4.10.

### Pendientes derivados (no en 1.4.11)

- STEP 4.5 || STEP 5 paralelo: diferido a 1.4.12 si vale la pena.
- STEP 7 || STEP 8 paralelo: diferido a 1.4.12 si vale la pena.
- Limpieza periódica de `identifierEnrichDone` cuando rowKey ya está en `completedPNs`: en teoría redundante pero no crítico (cada key ~30 bytes; 7k keys = ~200KB en localStorage de 5MB).
- Métricas de performance por step en el panel (tiempo medio por SavePartNumber A vs B) — útil si quieres bajar la latencia de A.

### Archivos cambiados

- `remote/scripts/bulk-upload.js`:
  - `VERSION = '1.4.11'`.
  - `resumeState.identifierEnrichDone: []` agregado al init y al rehidratar resumes previos.
  - `resumeIdentifierSet` Set hidratado paralelo a `resumeCompletedSet`; log de resume incluye conteo.
  - `enrichWorker`: Call A (identifier-enrich) antes de Call B (heavy). Persistencia incremental cada 50 en `identifierEnrichDone`.
  - Medidor de memoria: `startMemoryGauge()` / `stopMemoryGauge()` con `performance.memory` polling 2s. CSS `.sa-mem` + `.sa-mem-warn` + `.sa-mem-crit`. Span `#sa-bu-mem` en header.
  - `showPanel()` arranca el gauge; `hidePanel()` lo detiene.
- `remote/config.json`:
  - `version: '1.4.11'`.
  - `bulkUpload.concurrency.savePartNumber: 5 → 8`.
  - `bulkUpload.concurrency.archive: 5 → 8`.
- `docs/applets/bulk-upload.md`: esta sección.
- `CLAUDE.md`: índice de applets actualizado a 1.4.11.

## 1.4.10: consolidación de modales + log circular + sub-fase visible en workers (Fix U, 2026-05-22)

**Contexto.** Durante la corrida masiva de Schneider (~7392 PNs) y Clientes Generales (~4272 PNs), Edge tronó con `SBOX_FATAL_MEMORY_EXCEEDED` (error 5) — esta vez NO por buffers de red sino por el `textContent` del modal `dl9-progress-overlay` creciendo sin tope. Cada batch de `log()` apendaba al `dl9-progress-text` (4212 PNs × varias líneas por etapa + 200+ batch lines de Precios) hasta rebasar el sandbox del renderer.

Adicional, el operador reportó dos issues de UX:
1. **Dos modales encimados confunden** — `dl9-progress-overlay` (modal grande de pantalla completa con log y barra) + `#sa-bu-panel` (panel flotante arrastrable con barra, fase y contadores). Mismo info duplicada, modal grande tapando la app de Steelhead.
2. **Etapas "mudas" cuando son largas** — `setPanelPhase('Paso 6/9: Enriqueciendo PNs')` se setea una vez, los workers paralelos procesan miles de PNs durante 15-30 min sin update visible de qué PN está in-flight. El operador ve la barra moviéndose pero no sabe si está en labels, specs, racks, archive, etc.

### Fix

1. **Eliminado `dl9-progress-overlay`** — el modal grande de progreso ya no se usa. Toda la UI de progreso vive en `#sa-bu-panel`. Removidas las funciones `showProgressUI`, `updateLiveProgressText` y los defensivos `removeOverlay(dl9-progress-overlay)` repartidos por el flujo (3 sitios).
2. **Log circular en `#sa-bu-panel`** — nuevo `addPanelLog(msg)` con ring buffer `PANEL_LOG_MAX = 200` líneas. Cada línea con timestamp `[HH:MM:SS]`. Cuando se llena, recorta a las últimas 200. Sin crecimiento ilimitado del DOM.
3. **Sub-fase en panel** — nuevo `<div class="sa-subphase" id="sa-bu-subphase">` debajo de la fase principal. Función `setPanelSubPhase(text)` se invoca dentro de cada worker (enrichWorker, step6bWorker, unarchive-pre, sentinel archive, predicted archive, default-price, archiveWorker) para mostrar el PN/operación in-flight. Cuando cambia la fase principal, la sub-fase se limpia automáticamente.
4. **Migración de 21 call-sites** — todos los `showProgressUI(...)` ahora son `setPanelPhase(...)`. Los `log(...)` que reportaban resúmenes (ej. `-> N PNs creados`) son `addPanelLog(...)`. Las etapas con batches ruidosos (Precios batch N/M) usan `setPanelSubPhase` para el batch actual + `addPanelLog` cada 10 batches o al final, no por batch.

### Por qué ring buffer (no `cap` único)

Capar el `textContent` a `slice(-N chars)` falla porque cada `log()` lee → recorta → re-asigna el string completo: O(N²) en escrituras y allocación cara. El ring buffer en `state.panelLog[]` mantiene un array de strings, se hace `push + slice(-200)`, y el `textContent` se rebuild una sola vez con `join('\n')`. Cap predecible en 200 líneas × ~120 chars = 24KB DOM máx.

### Por qué sub-fase con `setPanelSubPhase` (no logs)

El operador necesita "qué está procesando AHORA" — los logs son histórico. Sub-fase muestra el PN/operación in-flight del último worker que ejecutó. Con concurrencia 5, el sub-fase oscila rápido entre 5 PNs, pero el ojo lee uno cualquiera y entiende que está en X step. Logs siguen funcionando para el resumen ("Enrich: 4180 OK, 12 retry").

### Por qué los logs masivos de batches no van a `addPanelLog`

Antes (≤1.4.9), `log('  Precios batch 5: 20 PNs')` se ejecutaba ~200 veces. Esto inflaba el log circular sin aportar info útil (el operador no necesita ver cada batch). En 1.4.10:
- `setPanelSubPhase('Precios batch 5/200 (20 PNs)')` — visible en pantalla, no se acumula en el log.
- `addPanelLog('Precios: 100 PNs procesados')` — solo cada 10 batches o al final. El log queda con ~20 líneas para esta etapa, no 200.

### Plan de validación pendiente

- [ ] Reanudar el run de Clientes Generales (resumeKey `17fc5ef8...`, phase `enrich-done`, ~4270 PNs) y confirmar que NO aparece el modal grande `dl9-progress-overlay`.
- [ ] Confirmar que el panel `#sa-bu-panel` muestra: barra, fase principal, sub-fase con PN actual, log con últimas 200 líneas máximo.
- [ ] Memoria del tab estable (DevTools → Memory): después de STEP 6/STEP 6b/STEP 8, el `Performance.memory.usedJSHeapSize` no debe crecer monotónicamente; el log circular debe recortarse visible al pasar de 200 entradas.
- [ ] Sub-fase visible durante STEP 6 (enrich), STEP 6b (sync), STEP 7 (racks), STEP 8 (archive) — el operador debe ver el PN procesándose cambiar cada ~0.5-1s.
- [ ] Resume natural sigue funcionando — `state.panelLog` se reinicia al arrancar, los logs viejos no se persisten en `localStorage` (solo `resumeState`).

### Pendientes derivados (no en 1.4.10)

- Análisis de paralelización adicional entre steps (mover Metal Base / labels / Quote IBMS a una corrida previa para que classifyPNs match correcto tras crash) — diferido a 1.4.11 / 1.5.0. Ver discusión en chat 2026-05-22.
- Posible split del enrich en dos fases (fase A: identificadores baratos = name+customer+labels+metalBase+QuoteIBMS; fase B: specs/params/racks/precios pesados). Justificación: cuando truena en fase B, el resume con fase A completa hace que `classifyPNs` haga match exacto vía labels/QuoteIBMS → cero duplicados al reanudar.

### Archivos cambiados

- `remote/scripts/bulk-upload.js`:
  - `VERSION = '1.4.10'`.
  - Removidas `showProgressUI`, `updateLiveProgressText`, `removeOverlay(dl9-progress-overlay)` (3 sitios).
  - `setProgressBar(p)` simplificada (solo `#sa-bu-bar`, no toca `dl9-bar`).
  - Nuevas: `setPanelPhase`, `setPanelSubPhase`, `addPanelLog` (ring buffer 200), `setPanelCounters`.
  - Panel HTML con nuevo `<div class="sa-subphase">`.
  - 21 call-sites migrados de `showProgressUI`/`log` a `setPanelPhase`/`setPanelSubPhase`/`addPanelLog`.
  - `setPanelSubPhase` invocado dentro de 6 workers: enrichWorker (STEP 6), step6bWorker (STEP 6b), unarchive-pre (STEP 4.5), sentinel archive (STEP 5), predicted archive, default-price reread, archiveWorker (STEP 8).
- `remote/config.json`: bump `version` a `1.4.10`.
- `docs/applets/bulk-upload.md`: esta sección.
- `CLAUDE.md`: índice de applets actualizado.

## 1.4.9: fix de duplicados de params en STEP 6b + cleanup defensivo + checkpoints intermedios + z-index del Detener (Fix T, 2026-05-22)

**Contexto.** Tras el run masivo de Schneider (~4799 PNs en STEP 6b), el operador detectó dos problemas:
1. **Duplicados de params**: en PNs existentes con specs ya linkeadas (`linkedSpecs`), aparecían dobletes idénticos en `partNumberSpecFieldParams` — uno con `processNodeId` real (asignado por STEP 6) y otro con `processNodeId: null`. Visualmente en la UI de Steelhead, el spec mostraba dos filas con el mismo valor de param (ej. "5-10 µm") pero distinto ProcessNode (uno con el nodo real, otro con "Ninguno").
2. **Botón Detener inalcanzable**: el panel flotante `#sa-bu-panel` quedaba detrás del modal `dl9-overlay` por z-index (99998 vs 99999) → al querer cancelar el run que se atoró en 4795/4799 sync params, no había forma de clickear "Detener" por UI.

Adicional: el `cancelRun()` solo modificaba `state.phase` (memoria) — el `resumeState` en localStorage quedaba con la fase del último checkpoint mayor (o `init` si nunca se completó STEP 6). El modal de resume mostraba "Fase actual: init" para corridas que ya habían avanzado mucho más, confundiendo el diagnóstico.

### Root cause del duplicado (STEP 6b vs STEP 6)

STEP 6 (`enrichWorker`) arma `specsToApply` con `defaultSelections` que incluyen `processNodeId: part.processId || pn.defaultProcessNodeId || null`. Pero **si el PN ya tenía la spec linkeada** (`alreadyLinkedSpecIds.has(s.specId)`), STEP 6 NO la reenvía — para evitar `unique_constraint` en la tabla `partNumberSpec`. Eso significa que los params asociados a esa spec ya-linkeada tampoco se actualizan en STEP 6.

STEP 6b cubre ese hueco: hace `GetPartNumber` fresco y agrega los params faltantes vía `AddParamsToPartNumber`. **Pero** insertaba con `processNodeId: null` (líneas 3965-3967 en ≤1.4.8) en vez del `processNodeId` real que STEP 6 hubiera usado. Si una corrida previa (o STEP 6 de la misma corrida) ya había dejado un row con `processNodeId` real para el mismo `specFieldParamId`, el dedup de STEP 6b (línea 3963 en ≤1.4.8) lo ignoraba porque solo agrupaba por `specFieldParamId`, sin considerar el tuple `(specFieldParamId, processNodeId)`. Resultado: insertaba un segundo row con `processNodeId: null` → duplicado.

### Fix

1. **Dedup por tuple `(specFieldParamId, processNodeId)`** — `existingParamKeys` en STEP 6b ahora se construye como `${id}|${processNodeId || ''}`. Si ya existe el par exacto, no se reinserta.
2. **`processNodeId` correcto en `paramsToAdd`** — pasa de `null` a `part.processId || pnNode.defaultProcessNodeId || null`, alineado con la lógica de STEP 6. Si más adelante alguien quiere un row con `processNodeId: null` intencional, será otro path (no este).
3. **STEP 0 cleanup defensivo integrado en STEP 6b** — antes del loop de specs, detectar pares activos del mismo `specFieldParamId` donde uno tiene `processNodeId !== null` y otro `processNodeId === null`. Archivar el null vía `SavePartNumber.partNumberSpecFieldParamsToArchive`. Idempotente: si no hay duplicados, no hace nada. Reusa el `GetPartNumber` fresco que STEP 6b ya hace (cero round-trips extra fuera del SavePartNumber del archive). El array `allParams` en memoria se filtra para que el dedup tuple del loop siguiente no vea los archivados como existentes, y se invalida `existingPnFullCache` para consumidores posteriores.
4. **Checkpoints intermedios `sync-done` y `racks-done`** — `resumeState.phase` se persiste tras STEP 6b (`sync-done`) y antes de STEP 8 (`racks-done`). Sin esto (≤1.4.8), `resumeState.phase` saltaba directo de `enrich-done` a `done`; un crash en STEP 7 o STEP 8 mostraba en el modal "Fase actual: enrich-done", impreciso.
5. **`cancelRun()` persiste `phase: 'cancelled'`** — además de tocar `state.phase` (memoria), ahora también `resumeState.phase = 'cancelled'` con fire-and-forget `persistResumeState()`. El modal de resume refleja el estado real.
6. **z-index del panel #sa-bu-panel subido a 100000** — antes 99998, por debajo del `dl9-overlay` (99999) → tapado por el modal "Ejecutando..." de `showProgressUI`. Ahora flota encima y el botón Detener es siempre alcanzable.

### Por qué el cleanup defensivo se queda en STEP 6b (no como STEP separado)

STEP 6b ya hace `GetPartNumber` fresco para todos los `step6bCandidates` (PNs existing con specs no-dash). Meter el cleanup ahí significa:
- Cero round-trips extra para detectar duplicados (reusa `allParams` del fetch fresco).
- Un solo `SavePartNumber` por PN con `partNumberSpecFieldParamsToArchive` cuando hay duplicados (no agregamos calls si no hay).
- Idempotente: corre siempre, incluso si no había duplicados — `duplicateNullIdsToArchive.length === 0` salta el `SavePartNumber`.

### Cómo resume el caso del run de Schneider sin re-clasificar PNs

El usuario quería reanudar el run que se atoró en STEP 6b 4795/4799 sin re-tomar decisiones de dropdowns. El resume natural lo cubre porque:
- `resumeState.classifications` persiste `userOverride`, `userDecided`, `pase`, `targetPnId`, `candidates` (líneas 2715-2725). Al reanudar, líneas 2675-2700 los rehidratan ANTES de pisar el snapshot.
- `resumeState.completedChunks` saltea cotizaciones ya creadas (línea 3261).
- `resumeState.archivedSentinelsPreQuote` saltea sentinels ya archivados en STEP 5 (1.4.8).
- `resumeState.completedPNs` saltea PNs ya enriched en STEP 6 (línea 3579).
- STEP 6b se ejecuta para todos los `step6bCandidates` — pero con el fix de tuple + cleanup defensivo, es idempotente: archiva los null duplicados al pasar por cada PN.
- STEP 7 y STEP 8 corren completos (nunca habían pasado).

### Plan de validación pendiente

- [ ] Reanudar el run de Schneider y confirmar que el log muestra `Cleanup duplicados (1.4.9): N params null archivados en M PNs` con N ≈ varios cientos.
- [ ] Spot-check 5 PNs en la UI de Steelhead: el spec debe mostrar un solo row con el param y ProcessNode correcto, sin "Ninguno".
- [ ] Después de STEP 6b, el modal de resume (si lo abres en otro tab) debe mostrar `Fase actual: sync-done`.
- [ ] STEP 7 Racks: confirmar que se aplican `partsPerRack` y `rackTypes` para todas las filas con racks en el CSV.
- [ ] STEP 8 Archive: confirmar que los PN SRG a archivar quedan archivados y los nuevos PN quedan default-priced.
- [ ] Bug del Detener: durante STEP 6b/7/8, clickear "Detener" debe funcionar al primer intento sin trucos de consola.

### Pendientes derivados (no en 1.4.9)

- UI "Forzar resume desde fase" — descartada para 1.4.9 porque el resume natural + checkpoints intermedios cubren el caso operacional. Si vuelve a hacer falta, replantear en 1.5.x.
- Lógica de skip-by-phase en el runner (saltear STEP 5/6/6b si `phase === 'sync-done'`) — diferida. Hoy el resume natural saltea por marcadores granulares (`completedPNs`, `archivedSentinelsPreQuote`, `completedChunks`) que son más seguros que un skip por fase ancho. Si la performance del resume natural se vuelve un cuello, evaluar.

### Archivos cambiados

- `remote/scripts/bulk-upload.js`:
  - `VERSION = '1.4.9'`.
  - `cancelRun()` persiste `resumeState.phase = 'cancelled'` con fire-and-forget.
  - CSS `#sa-bu-panel` `z-index: 99998` → `100000`.
  - STEP 6b: cleanup defensivo (detecta y archiva params null duplicados antes del loop de specs); dedup por tuple `(specFieldParamId, processNodeId)`; `paramsToAdd` con `processNodeId: targetProcessNodeId` (no null).
  - Checkpoint `phase = 'sync-done'` tras STEP 6b; `phase = 'racks-done'` antes de STEP 8.
- `remote/config.json`: bump `version` a `1.4.9`.
- `docs/applets/bulk-upload.md`: esta sección.
- `CLAUDE.md`: índice de applets actualizado.

## 1.4.8: persistencia intra-STEP 5 + concurrencia dedicada al archive sentinel pre-cotización (Fix S, 2026-05-22)

**Contexto.** En una corrida masiva de Schneider (~5879 PNs existentes con sentinel `-`) el tab de Edge crasheó con `SBOX_FATAL_MEMORY_EXCEEDED` (error 5) durante el STEP 5 a la altura de 5728/5879. Steelhead estaba respondiendo bien; el cuello no era red sino memoria del sandbox del renderer. Tres corridas paralelas en distintos tabs del mismo Edge multiplicaron la presión y dos de tres tabs murieron por OOM.

El crash NO era bug del código, era saturación: el STEP 5 corre `SavePartNumber` con concurrencia 5 sobre miles de PNs antes de empezar el chunk loop, y los buffers de los responses GraphQL en vuelo + closures retenidos terminaron por rebasar el límite del sandbox.

### Problema #1: retrabajo del 100% al reanudar

`resumeState.phase` se commitea entre pasos mayores, no intra-paso. Si el crash ocurría a la mitad del STEP 5 (5728 de 5879), al reanudar la corrida volvía a procesar los 5879 sentinels desde cero. Idempotente (archivar specs ya archivadas es no-op silencioso en `SavePartNumber`), pero costoso: ~10 min de retrabajo + se vuelven a inflar los mismos buffers que tronaron el tab la vez pasada.

### Problema #2: concurrencia compartida con `savePartNumber`

`sentinelConcurrency` leía de `bulkCfg().concurrency.savePartNumber` (= 5). Bajar ese número afectaría TODOS los pasos que usan SavePartNumber (STEP 6, STEP 7 enrichment, etc.), no solo el STEP 5. No teníamos una palanca dedicada al paso que más memoria consume en runs grandes.

### Fix

1. **`resumeState.archivedSentinelsPreQuote: string[]`** — set de `pnId` cuyo archive de sentinels ya quedó OK. Inicializado en `[]` en runs frescos; hidratado defensivamente en runs pre-1.4.8 que no traigan la clave.
2. **Filtrado al armar `sentinelTargets`** — los `pnId` que ya están en el set se saltean ANTES del `runPool`. Un crash + reanudación tras procesar 5728 → siguiente corrida arranca con solo 151 targets.
3. **Buffer local + flush periódico** — los `pnId` que terminan OK se acumulan en `sentinelArchivedBuffer` (local al closure del STEP 5). Cada 100 items completados, el callback de progreso del `runPool` dispara `flushSentinelBuffer()` que copia el buffer a `resumeState.archivedSentinelsPreQuote` y persiste a `localStorage`. Flush final tras el `runPool` para no perder el último parcial.
4. **Concurrencia dedicada `concurrency.sentinelPreQuoteArchive`** — default 3 (vs 5 que tenía compartido con `savePartNumber`). Reduce ~30% el pico de buffers GraphQL en vuelo en este paso sin tocar los otros. Si la clave no está en `config.json`, cae al default de `savePartNumber` para retro-compat.
5. **NO se limpia `archivedSentinelsPreQuote` al terminar STEP 5** — la lista vive durante toda la corrida. Si un crash ocurre en STEP 6/7 después de que STEP 5 terminó OK, el resume vuelve a entrar a STEP 5 y necesita la lista para saltear. 5879 UUIDs ≈ 420KB de localStorage, cabe holgadamente. La purga se hace cuando `phase === 'done'` (vía `deleteResumeStateByKey`, ya existente).

### Por qué cada 100 y no cada item

Persistir `localStorage` por cada `SavePartNumber` exitoso ampliaría I/O a ~5879 writes en serie. Cada 100 da grano fino (en el peor caso pierdes ~100 items de progreso, ~30s de trabajo) sin saturar el storage ni meter latencia al pipeline. El callback de progreso del `runPool` ya se invoca por item completado (línea 358-361), así que el chequeo `buffer.length >= 100` es free.

### Archivos cambiados

- `remote/scripts/bulk-upload.js`:
  - `VERSION = '1.4.8'`
  - `bulkCfg()` expone `concurrency.sentinelPreQuoteArchive` (default 3, fallback a `savePartNumber`).
  - `resumeState` inicial lleva `archivedSentinelsPreQuote: []`; hidratación defensiva en la rama de resume.
  - STEP 5 filtra targets contra el set, usa la concurrencia dedicada, mantiene buffer local y flushea cada 100.
- `remote/config.json`:
  - bump `version` a `1.4.8`.
  - `bulkUpload.concurrency.sentinelPreQuoteArchive: 3`.

### Plan de validación

- Resumes desde crash mid-STEP 5: el conteo de "saltados (sentinels ya archivados en corrida previa)" debe coincidir con el progreso reportado antes del crash (±100 por el ventana de flush).
- Verificar en DevTools (Application → Local Storage → `bulkUploadResume__<runKey>`) que `archivedSentinelsPreQuote.length` crece monotónicamente durante STEP 5.
- Confirmar que el tab vivo no se ve afectado por el deploy (no recarga 1.4.8 hasta que el usuario recargue tab o reinicie extensión).
- Medir tiempo del STEP 5 con concurrencia 3 vs 5: probablemente 1.4-1.7× más lento, aceptable a cambio de no tronar el sandbox.

### Pendientes derivados (1.4.9+)

- Auditar otros pasos que mantienen colecciones grandes en memoria (`existingPnFullCache`, `pnLookup`) para ver si conviene flush periódico.
- Considerar `console.log` gating por flag `DEBUG` — durante el crash, 1015 mensajes acumulados en consola amplificaron la presión de memoria (item ya listado en el audit pre-producción del CLAUDE.md root).
- Investigar si STEP 5 se puede batchear (un `SavePartNumber` con input de N PNs en lugar de N llamadas), para reducir el número de responses GraphQL en vuelo.

---

## 1.4.7: bulkCfg() leía de api().getConfig() que no existe — config nunca llegaba al matcher (Fix R, 2026-05-22)

**Contexto.** Tras el deploy de 1.4.6 el usuario reportó dos escenarios que demostraban que el filtro nonFinish y las equivalencias semánticas seguían muertos en producción:

1. **Plata Flash vs Plata** (Image #13): CSV `[Plata Flash]` no matcheaba con PN existente `[Plata]` a pesar de que `metalEquivalents` los agrupa.
2. **NP Desconocido como blank** (Image #14): PN candidato `[NP Desconocido]` debería filtrarse a `[]` y caer en la rama blank-candidate, pero el modal mostraba el chip `NP Desconocido` y el default era `🆕 Crear nuevo PN`.

### Causa raíz

El fix de 1.4.6 wireó `nonFinishLabelNames` y `metalEquivalents` al shape de `bulkCfg()`, pero la **fuente** de donde leía el config estaba rota desde 1.4.3:

```js
const cfg = (api()?.getConfig?.() || window.__sa_config || {});
```

- `SteelheadAPI` (`remote/scripts/steelhead-api.js:170`) NO expone `getConfig` — solo `init`, `query`, `queryWithFallback`, `keepAlive`, `getDomain`, `getHash`, `getLog`, `copyLastLog`, `log`, `warn`. Así que `api()?.getConfig?.()` siempre devolvía `undefined`.
- `window.__sa_config` tampoco existe — el background (`extension/background.js:102`) setea `window.REMOTE_CONFIG`, no `__sa_config`.

Resultado: `cfg = {}` siempre → `d = {}` → todo el shape de `bulkCfg()` devolvía sus defaults. Para casi todas las claves (`concurrency`, `retry`, `paging`, `preview`, `resume`, `chunking`) los defaults coinciden con el config, así que el bug pasó desapercibido. Pero para `nonFinishLabelNames` y `metalEquivalents` el default es `[]` — y el matcher operó con lista vacía desde 1.4.3, sin importar lo que dijera el config.

### Fix

Leer primero de `window.REMOTE_CONFIG` (que el background SÍ setea), con fallbacks defensivos:

```js
const cfg = window.REMOTE_CONFIG || api()?.getConfig?.() || window.__sa_config || {};
```

Cero cambios en el clasificador ni en la UI.

### Archivos cambiados

- `remote/scripts/bulk-upload.js`:
  - `VERSION = '1.4.7'`
  - `bulkCfg()` ahora lee de `window.REMOTE_CONFIG` primero.
- `remote/config.json`: bump `version` a `1.4.7`.

### Plan de validación pendiente

- Confirmar en DevTools sobre la pestaña de Steelhead, después de recargar la extensión:
  ```js
  // Debe incluir nonFinishLabelNames y metalEquivalents con datos
  Object.keys(window.REMOTE_CONFIG?.steelhead?.domain?.bulkUpload || {});
  ```
- Options del Pase 3 con candidatos `[NP Desconocido]` deben mostrar `sin-etiq` (no `etiq:[NP Desconocido]`) y caer en blank-candidate como default.
- Filas CSV `[Plata Flash]` vs PN existente `[Plata]` deben matchear en Pase 2 (`composite-exacto-*`), no llegar a Pase 3.

### Pendientes derivados

- Auditar otros applets que usen el patrón roto (`api()?.getConfig?.() || window.__sa_config`). Candidatos: `process-deep-audit`, `spec-params-bulk`, `po-comparator`.
- Considerar exponer `getConfig()` directamente en `SteelheadAPI` para unificar el acceso y eliminar la dependencia frágil en `window.REMOTE_CONFIG`.

---

## 1.4.6: bulkCfg() exponía nonFinishLabelNames/metalEquivalents — equivalencias muertas (Fix Q, 2026-05-22)

**Contexto.** Usuario en página 3 de validaciones, reporta que en una sola fila (L1538, 80255-103-01, SCHNEIDER) el matcher no detectó que **CSV `Decapado + Plata + SRG` ≡ PN `Decapado + Plata Flash`**, a pesar de que el config (desde 1.4.3) define ambos como equivalentes:

- `nonFinishLabelNames` incluye `"SRG"` → debería filtrarse antes de comparar.
- `metalEquivalents` incluye `["Plata", "Plata Flash"]` → deberían colapsar al mismo token canonical.

La fila cayó en Pase 3 como DUP cuando debía haberse resuelto en Pase 2 (`composite-exacto-*`) automáticamente. Los chips del modal mostraban `✓ Decapado, × Plata, × SRG` — evidencia de que la UI también ignoraba el nonFinish list y el equivIndex.

### Causa raíz

El helper `bulkCfg()` (línea 67) devuelve un objeto **sin** `nonFinishLabelNames` ni `metalEquivalents`. Bug introducido en 1.4.3 cuando se agregaron esas claves al `config.json` pero se olvidó wirearlas en el shape de `bulkCfg()`.

Resultado: tanto en clasificación masiva (`classifyPNsMassive` línea 962-964) como en clasificación on-demand (`classifyPNsOnDemand` línea 983-985) Y en el render de chips del modal Pase 3 (línea 1592-1594), las llamadas a `cfg.nonFinishLabelNames || []` y `buildEquivIndex(cfg.metalEquivalents)` siempre recibían `undefined` → lista vacía / Map vacío. Las equivalencias del config nunca llegaron al matcher en producción.

### Fix

Agregar las dos claves al objeto que devuelve `bulkCfg()`:

```js
nonFinishLabelNames: Array.isArray(d.nonFinishLabelNames) ? d.nonFinishLabelNames : [],
metalEquivalents: Array.isArray(d.metalEquivalents) ? d.metalEquivalents : [],
```

Cero cambios en clasificadores ni en UI — el bug era 100% del shape de config.

### Archivos cambiados

- `remote/scripts/bulk-upload.js`:
  - `VERSION = '1.4.6'`
  - `bulkCfg()` ahora propaga `nonFinishLabelNames` y `metalEquivalents` desde `cfg.steelhead.domain.bulkUpload`.
- `remote/config.json`: bump `version` a `1.4.6`.

### Plan de validación pendiente

- Próxima corrida con CSV que tenga combinaciones `Plata` (CSV) vs `Plata Flash` (PN existente) → debería caer en Pase 2 (composite-exacto) automáticamente, no en Pase 3.
- Verificar que filas con etiquetas planta (`SRG`, `SMY`, `STX`, `SCM`, etc.) ya no muestren esos chips en el modal — solo etiquetas reales de acabado.
- Si por alguna razón el bug persiste post-deploy, abrir DevTools y ejecutar `BulkUpload.__test().bulkCfg()` (o equivalente) para confirmar que el shape ya trae los arrays no vacíos.

### Pendientes derivados

- Auditar otros applets por el mismo patrón: claves de config agregadas pero no wireadas en su helper local. Candidatos: `process-deep-audit`, `spec-params-bulk` (también tienen `<applet>Cfg()` helpers).
- Considerar test unitario sobre `bulkCfg()` que valide round-trip de TODAS las claves de `config.steelhead.domain.bulkUpload`.

---

## 1.4.5: Pase 3 — userDecided separado de userOverride + altura modal + "Aceptar visibles" (Fix P, 2026-05-22)

**Contexto.** Tras deploy de 1.4.3/1.4.4 el usuario reportó dos UX bugs en el modal Pase 3:

1. "Subió muy poco el espacio de la ventana, ahora puedo resolver 2 y media [filas]" — el wrap interno tenía `max-height:300px` hardcoded; el bump anterior del modal (a 96vh) no propagaba al contenedor de tabla.
2. "Cuando estoy de acuerdo con tu sugerencia no doy click y no sabes que ya no está pendiente, pero además, cuando sí doy click y vuelvo a seleccionar lo que pusiste, aún así me sigue diciendo que la decisión está pendiente."

### Causa raíz

**Bug A — altura del wrap interno fija.** En el preview del modal hay un `<div id="dl9-table-wrap" style="max-height:300px;...">` (línea 1363). El modal padre crece a 96vh con 1.4.3 pero el wrap interno seguía limitado a 300px, dejando solo ~2.5 filas Pase 3 visibles.

**Bug B — semántica de `userOverride` confundía dos conceptos.** El campo significaba "el operador eligió algo DISTINTO al default" (null cuando coincide con la sugerencia del clasificador). Pero el counter `decidedNow` lo usaba como proxy de "el operador validó la fila":

- Si el operador estaba de acuerdo con la sugerencia y NO clickeaba → `userOverride=null` → contaba como pendiente.
- Si el operador clickeaba el select y re-seleccionaba la misma opción → el evento `change` NO se dispara (HTML spec) → `userOverride` queda como estaba.
- Si clickeaba y elegía otra opción y luego volvía a la sugerencia → `userOverride` se reseteaba a null → fila vuelve a aparecer pendiente.

### Fix

**Campo separado `userDecided: false` en `pnStatus`** (línea ~1156). Tracking explícito de "el operador validó esta fila", independiente de si su decisión coincide con el default.

**Triggers:**
- `sel.addEventListener('change', ...)`: marca `userDecided=true` además de actualizar `userOverride` como antes.
- `sel.addEventListener('click', ...)`: marca `userDecided=true` aunque el operador re-seleccione la misma opción (cubre "vuelvo a elegir lo mismo que pusiste").
- Botón **"✓ Aceptar visibles"** en el header de pendientes: marca todas las filas Pase 3 de la página actual como validadas con su valor actual del select. Un click por página en vez de uno por fila.

**Wrap interno**: `max-height:300px` → `max-height:calc(96vh - 280px); min-height:300px`. Aprovecha viewport disponible.

### Archivos cambiados

- `remote/scripts/bulk-upload.js` (~1155, 1363, 1431-1500, 1885-1910, 1900-1920, 2645-2660, 2685, 2150).
- `remote/config.json`: bump `version` a `1.4.5`.

### Plan de validación pendiente

- [ ] Wrap muestra 5-7 filas Pase 3 en vez de 2.5.
- [ ] Click sobre select con re-elección del mismo valor → contador avanza, chip "✓ validada".
- [ ] Botón "✓ Aceptar visibles" marca toda la página en un click.
- [ ] Reload → REANUDAR → `userDecided` restauradas.

---

## 1.4.4: cuello STEP 8 SOLO_PN + progreso visible STEP 4.5/5/8 + cuota sa_load_history (Fix O, 2026-05-22)

**Contexto.** La corrida de 1501 PNs en modo SOLO_PN terminó exitosamente con `success: true, errors: []` (1342 nuevos + 159 existentes, 1501 default prices, 1501 archivados), **pero**:

1. El usuario reportó que se "atoraba en Paso 5: Archivado..." viendo en DevTools cientos de `GetPartNumber` (no `UpdatePartNumber`) consecutivos sin que la UI avanzara visualmente.
2. Al cerrar la corrida apareció el warn `Failed to execute 'setItem' on 'Storage': Setting the value of 'sa_load_history' exceeded the quota`.

### Causa raíz (3 bugs interconectados)

**Bug A — STEP 8 SOLO_PN tiene `for` secuencial de `GetPartNumber` (sin runPool).** En modo SOLO_PN no se conoce el ID del precio recién creado (`SaveManyPartNumberPrices` no devuelve IDs), entonces el código re-lee los precios de cada PN antes de poder fijar el default (líneas ~4007–4032 en 1.4.3):

```js
for (let i = 0; i < parts.length; i++) {
  // ...
  if (!needsRead) continue;
  try {
    const pnData = await api().query('GetPartNumber', { partNumberId: entry.pn.id });
    // ...
  } catch (_) {}
}
```

Con ~1500 PNs y ~300–800 ms por llamada en serie, esto tarda **7–20 minutos**, y durante todo ese rato la UI muestra "Paso 5: Archivado..." sin progreso. El archivado real (líneas 4051+) ya usaba `runPool` con concurrencia 5 y `setPanelProgress`, pero el usuario nunca llegaba a verlo porque el cuello estaba antes.

**Por qué el usuario veía solo `GetPartNumber` "como loco" en DevTools.** Porque eran exactamente esos 1500 GETs secuenciales antes del archivado real con `UpdatePartNumber`. El texto "Paso 5: Archivado..." que pone `showProgressUI` (línea 3968) se setea ANTES de ese loop, no después.

**Bug B — STEP 4.5 desarchive y STEP 5 sentinel archive no actualizan el panel.** Sus `onProgressCb` de `runPool` solo movían `setProgressBar` 3% (de 13→16 y de 16→19 respectivamente). El panel principal (`#sa-bu-current/total`) y el `#dl9-live-progress` quedaban estáticos. Por contraste STEP 6 enrich (línea 3670) ya llamaba `setPanelProgress(done, total)` correctamente.

**Bug C — `sa_load_history` excede cuota de localStorage.** Cada entry de `loadLog` incluía:
- `parts: parts.map(p => ({...30+ campos}))` — ~1 MB por corrida grande.
- `log: api().getLog()` — texto completo de la sesión, ~1–2 MB por corrida con 1500 PNs.

Cap previo: 50 entradas. Teórico máximo: ~150 MB. Chrome localStorage limit: ~5 MB. Tras pocas corridas grandes el `setItem` reventaba.

### Fix

**A. STEP 8 SOLO_PN: meter el loop en `runPool`.** Pre-filtramos a un array `priceReadTargets`, lanzamos `runPool` con `concurrency.savePartNumber || 5` y `withRetry`, actualizamos `setPanelProgress(done, total)` por cada item. La sección anuncia su propia fase: `setPanelPhase('Releyendo precios para fijar default (N)')` antes de empezar.

```js
const priceReadTargets = [];
for (let i = 0; i < parts.length; i++) {
  // pre-filtrado igual que antes
  if (!needsRead) continue;
  priceReadTargets.push({ pnId, pnName, precioDefault });
}
if (priceReadTargets.length) {
  setPanelPhase(`Releyendo precios para fijar default (${priceReadTargets.length})`);
  setPanelProgress(0, priceReadTargets.length);
  await runPool(priceReadTargets, async (target, _i, myRunIdLocal) => {
    const pnData = await withRetry(() => api().query('GetPartNumber', { partNumberId: target.pnId }), ..., myRunIdLocal);
    // mismo procesamiento de prices que antes
  }, priceReadConcurrency, (done, total) => {
    setPanelProgress(done, total);
    setProgressBar(86 + Math.round((done / total) * 2));
  }, myRunId);
}
```

Beneficios:
- 5× speed-up inmediato a concurrencia 5 → ~2 min en vez de 7–20 min.
- UI viva: el panel cuenta 1/1500, 2/1500, ...
- `withRetry` agrega resiliencia que antes no tenía (el `try/catch (_) {}` original tragaba errores silenciosamente sin reintentar).

**B. STEP 4.5 + STEP 5 sentinel: agregar `setPanelPhase` + `setPanelProgress`.**

```js
// STEP 4.5
setPanelPhase(`Desarchivando PNs pre-enrich (${pnsToUnarchivePre.length})`);
setPanelProgress(0, pnsToUnarchivePre.length);
// ... runPool con onProgressCb: setPanelProgress(done, total); setProgressBar(...)

// STEP 5 sentinel
setPanelPhase(`Archive specs sentinel pre-quote (${sentinelTargets.length})`);
setPanelProgress(0, sentinelTargets.length);
// ... runPool con onProgressCb: setPanelProgress(done, total); setProgressBar(...)
```

`setPanelPhase` ya actualiza automáticamente `#dl9-live-progress` vía `updateLiveProgressText` (línea 454), entonces el modal viejo (`dl9-progress-overlay`) también refleja la fase.

**C. `sa_load_history`: quitar `log`, cap 50→20, auto-prune por QuotaExceededError.**

```js
// Antes
log: api().getLog(),     // ← quitado: ya va en XLSX
if (history.length > 50) history.length = 50;
localStorage.setItem('sa_load_history', JSON.stringify(history));

// Después
// (sin field log)
if (history.length > 20) history.length = 20;
try {
  localStorage.setItem('sa_load_history', JSON.stringify(history));
} catch (quotaErr) {
  let attempts = 0;
  while (history.length > 1 && attempts < 6) {
    attempts++;
    history.length = Math.floor(history.length / 2) || 1;
    try { localStorage.setItem(...); break; } catch (_) {}
  }
}
```

El `log` completo de la corrida ya se persiste en el XLSX de reporte (`bulk-upload-report-*.xlsx`), entonces no se pierde nada útil. El historial sigue sirviendo para "view-load-history" y "download-load-csv" (que solo usa `parts`).

### Archivos cambiados

- `remote/scripts/bulk-upload.js`:
  - `VERSION = '1.4.4'`
  - STEP 4.5 (~2927–2954): `setPanelPhase` + `setPanelProgress(0, total)` antes del runPool; `onProgressCb` ahora llama `setPanelProgress(done, total)`.
  - STEP 5 sentinel (~2976–3057): mismo patrón.
  - STEP 8 SOLO_PN price re-read (~4007–4062): `for` secuencial reemplazado por `runPool` con `withRetry`, `setPanelPhase`, `setPanelProgress`, `setProgressBar`.
  - `loadLog`: removido el field `log: api().getLog()` (~4174).
  - Cap historial 50→20 + auto-prune por `QuotaExceededError` (~4210–4230).
- `remote/config.json`: bump `version` a `1.4.4`.

### Plan de validación pendiente

- [ ] Próxima corrida SOLO_PN >500 PNs: confirmar que "Paso 5: Archivado..." ahora muestra fase "Releyendo precios..." con contador X/N + bar avanzando y termina en ~2 min en vez de 10+.
- [ ] STEP 4.5 y STEP 5 sentinel: contador visible.
- [ ] Después de varias corridas grandes consecutivas: NO debe aparecer el warn `'sa_load_history' exceeded the quota`. Si aparece, el auto-prune debe registrar el warn "cuota excedida, recortado a N entradas".
- [ ] `view-load-history` y `download-load-csv` siguen funcionando con cap=20.

### Pendientes derivados

- Considerar mover `sa_load_history` a `chrome.storage.local` (cuota ~10MB hasta unlimited) en una 1.5.x si el cap=20 termina siendo limitante. Requiere refactor mayor del popup.
- Documentar en `docs/architecture/dom-patterns.md` el patrón `setPanelPhase` + `setPanelProgress` para que futuras fases asíncronas no caigan en el mismo error.

---

## 1.4.3: matcher con equivalencias semánticas + UX modal Pase 3 (Fix N, 2026-05-22)

**Contexto.** Corrida con 1501 PNs (Solo_PN + COTIZACIÓN+NP) generó cientos de filas Pase 3 que el operador debía validar a mano una por una. Reportes en vivo:

1. "Sólo me deja validar de a dos por el espacio tan pequeño de la ventana, son muchos clicks".
2. "Estaño vs. Estaño s/Aluminio vs. Estaño s/Cobre serían equivalentes. También Plata vs. Plata Flash. Decapado vs. Decapado no la detectó, quizá porque el CSV trae la planta STX y esas se supone que se están excluyendo".
3. "El orden de etiquetas la toma como un diferencial y no lo es, el orden no importa".
4. "No puedo saber cuántas llevo porque no dice el número de línea".
5. "El tema de que no se guarda — al menos cada paso de página".

### Causa raíz (5 bugs interconectados)

**Bug 1 — `isNonFinishLabel` case+space-sensitive.** Línea 4164 usaba `nonFinishList.some(nf => nf.toUpperCase() === String(name).toUpperCase())` que NO trimea espacios. Si Steelhead devolvía `"SRG "` (con trailing space) o `"srg"` (lowercase, edge no observado pero posible), las 7 plantas (`SCM/SMY/SQ1/SQ2/SRG/STX/SXC`) escapaban al filtro y contaban como acabados → "Decapado + STX" se comparaba contra "Decapado" del CSV y fallaba.

**Bug 2 — Chips en modal no aplicaban `isNonFinishLabel`.** El render de chips CSV vs candidato (1737-1748 y 1753-1756) iteraba `r.csvLabels` y `candObjs` raw, sin filtrar nonFinish. Aunque el matcher SÍ los filtraba para clasificar, el operador veía chip "STX" o "SCM" pintado como `miss` en pantalla y dudaba si la fila debía ser match.

**Bug 3 — `score()` y `labelsMatchFull` no conocen equivalencias semánticas.** El matcher comparaba `c.metalBase === csvMetal` y `acabadosOrdenados(...) === acabadosOrdenados(...)` por string. "Estaño" vs "Estaño s/Aluminio" salía como `miss` aunque para el operador son intercambiables. Idem "Plata" vs "Plata Flash". → Cientos de filas que debían ser top match acababan en Pase 3 sin top.

**Bug 4 — Modal demasiado angosto.** CSS `max-width:min(1400px,96vw); max-height:88vh; padding:28px 32px` cabía ~2-3 filas Pase 3 por viewport. En un run de 1501 PN con ~500 Pase 3, eso son ~200 scrolls verticales.

**Bug 5 — Decisiones del modal "no se guardan" (percepción).** En realidad SÍ se persisten (`bulk-upload.js:1859-1863` llama `persistResumeState()` por cada cambio de dropdown, y `:2527-2545` restaura los `userOverride` al re-abrir el CSV con REANUDAR). Pero el operador no lo sabía: no había chip "✓ guardada", no había número de línea para llevar la cuenta, y al cancelar el modal no había feedback de que sus decisiones quedaron salvas.

### Solución

**Helpers nuevos (`bulk-upload.js:4156-4253`).**

```js
function normLabel(s) { return String(s ?? '').trim().toUpperCase(); }
function isNonFinishLabel(name, nonFinishList) {
  const n = normLabel(name);
  return !!n && nonFinishList.some(nf => normLabel(nf) === n);
}
function buildEquivIndex(groups) { /* Map<normLabel, groupId> desde config.metalEquivalents */ }
function equivalentValues(map, a, b) {
  const na = normLabel(a), nb = normLabel(b);
  if (na === nb) return true;
  const ga = map.get(na), gb = map.get(nb);
  return ga != null && gb != null && ga === gb;
}
function metalCanonico(metal, equivIndex) { /* "__M<groupId>" o normLabel */ }
function acabadosCanonicos(labels, nonFinishList, equivIndex) {
  // Filtra nonFinish, normaliza, colapsa equivalentes a "__G<groupId>",
  // dedup vía Set, sort, join("|"). Permite que "Estaño" y "Estaño s/Cobre"
  // cuenten como el mismo acabado.
}
```

**Threading `equivIndex` por el matcher.** `buildClassifiedRow` → `classifyOnePN` → `rankCandidates`, además de `dedupModifyTargets`. Construido una sola vez en `classifyPNsMassive`/`classifyPNsOnDemand` desde `cfg.metalEquivalents`.

```js
function rankCandidates(csvRow, candidates, nonFinishList, equivIndex) {
  const csvMetalCanon = metalCanonico(csvRow.metalBase || '', equivIndex);
  const csvAcabadosCanon = acabadosCanonicos(csvRow.labels || [], nonFinishList, equivIndex);
  function score(c) {
    let s = 0;
    if (metalCanonico(c.metalBase || '', equivIndex) === csvMetalCanon) s++;
    if (acabadosCanonicos(c.labels || [], nonFinishList, equivIndex) === csvAcabadosCanon) s++;
    return s;
  }
  // ...
}
```

**`buildCompositeKey` también canonicaliza.** Pase 2 ahora matchea "Estaño s/Aluminio" en el PN existente vs "Estaño" en el CSV sin caer a Pase 3 — un PN al click menos.

**Config (`config.json:343-349`).**
```json
"metalEquivalents": [
  ["Estaño", "Estaño s/Aluminio", "Estaño s/Cobre"],
  ["Plata", "Plata Flash"]
]
```
Vacío = se comporta como pre-1.4.3 (sólo exacto).

**UX modal Pase 3.**

| Cambio | Antes | Ahora |
|---|---|---|
| Ancho modal | `max-width:1400px / 88vh, padding 28×32` | `1800px / 96vh, padding 14×22` (≈2× espacio vertical) |
| Acción Pase 3 | `tdAct = "👇 decidir abajo"` (gris-italic) | Chip `✓ guardada` (verde) cuando `userOverride != null`, o `pendiente` (naranja-italic) |
| Número línea CSV | No había | `L<idx+2>` (header=1, primera data=2) en columna PN, monoespacio gris |
| Contador header | `N decisiones pendientes` | `Pase 3: X/Y validadas (Z restantes)` (decide = `userOverride != null`) |
| Chips CSV/candidato | Mostraban TODOS los labels (incluyendo STX/SMY/...) | Filtran nonFinish; agrupan equivalentes como match (Estaño ≡ Estaño s/Cobre se pinta verde) |
| Cancelar modal con decisiones tomadas | Cierra sin feedback | `alert()` "Guardé N decisiones — sube el mismo CSV y elige REANUDAR" |

El chip `✓ guardada` se re-pinta en `sel.change` mediante hook `wrap._renderSavedChip`.

### Cambios
- **`remote/config.json`:** bump `version` 1.4.2 → 1.4.3, `lastUpdated` 2026-05-22, agrega `metalEquivalents`.
- **`remote/scripts/bulk-upload.js:49`:** VERSION `1.4.2` → `1.4.3`.
- **`bulk-upload.js:1195`:** CSS modal más ancho/alto + clase `dl9-line-num`, `dl9-saved-chip`.
- **`bulk-upload.js:1421-1442`:** `updateHeaderStats` cuenta `decidedNow` (con override) vs `remainingNow`.
- **`bulk-upload.js:1474-1500`:** prefijo `L<idx+2>` en columna PN.
- **`bulk-upload.js:1538-1539`:** construcción de `equivIndexUI` en showPreview.
- **`bulk-upload.js:1544`:** filtro nonFinish en options del dropdown via `isNonFinishLabel`.
- **`bulk-upload.js:1704-1712`:** chips CSV (rama NEW) filtra nonFinish.
- **`bulk-upload.js:1729-1759`:** chips CSV/candidato filtran nonFinish + aceptan equivalencias.
- **`bulk-upload.js:1866-1893`:** quita "👇 decidir abajo"; agrega `savedChipSlot` con `renderSavedChip()`.
- **`bulk-upload.js:1862`:** re-pinta chip guardada al cambiar el select.
- **`bulk-upload.js:2036-2052`:** banner al cancelar modal con decisiones tomadas.
- **`bulk-upload.js:2589`:** dedupModifyTargets post-overrides recibe equivIndex.
- **`bulk-upload.js:960-1090`:** classifyPNsMassive/OnDemand construyen y propagan equivIndex.
- **`bulk-upload.js:1118-1126`:** buildClassifiedRow propaga a classifyOnePN.
- **`bulk-upload.js:4197-4253`:** helpers normLabel, buildEquivIndex, equivalentValues, metalCanonico, acabadosCanonicos.
- **`bulk-upload.js:4263-4395`:** rankCandidates + classifyOnePN aceptan equivIndex.
- **`bulk-upload.js:4476-4540`:** dedupModifyTargets canonicaliza acabados.
- **`bulk-upload.js:4569`:** export helpers a `__helpers` para test/snippets.

### Plan de validación
- [ ] Cargar 1.4.3 (recargar extensión); abrir CSV grande del run actual.
- [ ] En Pase 3: verificar que filas con "Estaño" vs "Estaño s/Aluminio" salen como top match (ya no requieren click).
- [ ] Misma cosa con "Plata" vs "Plata Flash".
- [ ] Verificar que chips de plantas (SCM/SMY/STX/...) NO se pintan ni en CSV ni en candidato.
- [ ] Confirmar que "Decapado vs Decapado" con CSV trayendo STX ahora matchea sin click.
- [ ] Comprobar que el contador del header dice "X/Y validadas (Z restantes)" y baja al hacer un click.
- [ ] Comprobar que prefijo `L42` aparece junto a cada PN.
- [ ] Hacer 3 clicks, cancelar modal → alert aparece. Volver a subir mismo CSV → "Corrida previa detectada" → REANUDAR → las 3 decisiones aplicadas.
- [ ] Editar el CSV (cambiar 1 carácter) → runKey cambia → NO ofrece resume.

### Pendientes derivados
- Bright Dip case: el usuario reportó "Bright Dip sí se tenía en un número de parte y no la hizo top match", pero sin caso específico para reproducir. Si vuelve a aparecer, capturar (CSV row + candidate PN id) y ver si conviene agregar Bright Dip a `metalEquivalents` o si el problema es un acabado distinto.
- Plan de rollback (item del audit pre-prod): pendiente desde 1.4.2; tags atados a `config.version` aún sin implementar.

## 1.4.2: Math.floor en partsPerRack + .size en racksToDelete (Fix M, 2026-05-21)

**Problema.** Corrida SOLO_PN con 102 PNs (Schneider/Brainin/CGR/Cuprum/Diseño y Metalmecánica): completó con 1 error y dos rarezas visuales:

```
[SA] ERRORES: 1
SavePartNumberRackTypes: Error: HTTP 400 en SavePartNumberRackTypes:
{"errors":[{"message":"Variable \"$input\" got invalid value 10775.86 at \"i…
[SA] Racks: 102 agregados, undefined PNs con racks eliminados
[SA] Summary panel → Racks: NaN
```

### Causa raíz

**Fix A — partsPerRack acepta decimal.** Línea 641 del CSV reader: `racks.push({ name: g(row, 41), ppr: gn(row, 42) })`. `gn()` devuelve número o `null` sin forzar Int. Cuando una celda AQ/AS del Excel trae decimal (fórmula con resultado no entero, o columna mal pegada), línea 3807 lo pasa tal cual a `partsPerRack: rk.ppr`. GraphQL valida `partsPerRack` como Int y rechaza con HTTP 400.

**Agravante crítico:** el catch de `SavePartNumberRackTypes` (línea 3852) solo hace fallback uno-por-uno si el error es `duplicateKey`. Si es validación de tipo, el `errors.push(...)` ejecuta y el batch entero de 50 racks **se pierde silenciosamente** — `stats.racksSet` cuenta intentos (`rackIn.length`), no éxitos, así que el resumen miente con "102 agregados". Para una sola celda mal en el Excel, hasta 49 racks vecinos no se insertan.

**Fix B — `racksToDelete.length` sobre un Set.** Línea 3791 lo declara `new Set()` (auto-dedup por `pn.id`), pero líneas 3860 y `stats.racksSet = rackIn.length + racksToDelete.length` leen `.length` (propiedad solo de Array). En `Set` el accessor correcto es `.size`. `undefined + número = NaN` → de ahí `Racks: NaN` en el summary y `undefined PNs con racks eliminados` en el log.

### Solución

**Fix A:**
```js
// remote/scripts/bulk-upload.js:3800-3812
for (const rk of part.racks) {
  if (isDash(rk.name)) continue;
  const rt = rackTypeByName.get(rk.name); if (!rt) { errors.push(...); continue; }
  if (rk.ppr === null) continue;
  // Fix M 1.4.2: GraphQL espera Int para partsPerRack.
  const ppr = Math.floor(rk.ppr);
  if (!Number.isFinite(ppr)) continue;
  if (ppr !== rk.ppr) log(`  WARN: rack "${rk.name}" PN id ${entry.pn.id} ppr=${rk.ppr} no entero → redondeado a ${ppr}`);
  ...
  rackIn.push({ rackTypeId: rt.id, partNumberId: entry.pn.id, partsPerRack: ppr });
}
```

- `Math.floor` redondea hacia abajo (decisión del operador — más permisivo que rechazar, y la fila culpable queda señalada en el log).
- `Number.isFinite` cubre el caso degenerado donde la celda no es número y `gn()` aún así devolvió algo no-numérico (defensa en profundidad).
- WARN con `entry.pn.id` permite identificar qué PN trae el decimal sin volver a correr — el operador busca el log y corrige el Excel.

**Fix B:**
```js
// línea 3860
stats.racksSet = rackIn.length + racksToDelete.size;
log(`  Racks: ${rackIn.length} agregados, ${racksToDelete.size} PNs con racks eliminados`);
```

### Cambios
- **`remote/config.json`:** bump `version` 1.4.1 → 1.4.2.
- **`remote/scripts/bulk-upload.js:VERSION`:** `1.4.1` → `1.4.2`.
- **`remote/scripts/bulk-upload.js:3800-3812`:** redondeo + warn por rack no-entero.
- **`remote/scripts/bulk-upload.js:3860`:** `.length` → `.size` (dos ocurrencias).

### Plan de validación
- [ ] Repetir corrida SOLO_PN del CSV "Schneider RG arch" + Brainin/CGR/Cuprum/Diseño (102 PNs). Confirmar:
  - Si la celda AQ/AS del PN problemático trae decimal, el log emite WARN identificando PN id + valor original + redondeado.
  - El batch de racks ya no se aborta — los 102 entran (o el subset correcto si hay racks con guión).
  - Summary panel: `Racks: <N>` (entero, no NaN), log final dice `Racks: X agregados, Y PNs con racks eliminados` (sin `undefined`).
- [ ] Verificar en Steelhead UI que los PNs del batch que fallaba en 1.4.1 ahora sí tengan su rack asignado con partsPerRack correcto.

### Pendientes derivados
- **Identificar la fila culpable del CSV.** El 10775.86 sigue siendo dato sucio en el Excel; el applet ahora lo redondea y no falla, pero el operador debe revisar la celda y decidir si era error de fórmula o realmente 10775 piezas (poco probable físicamente).
- **Fortalecer el catch del batch (futuro).** Si el endpoint cambia y rechaza por otro tipo de validación (no `Int`), el batch sigue cayendo entero — solo `duplicateKey` tiene fallback uno-por-uno. Considerar retry uno-por-uno también ante HTTP 400 genérico.
- **`stats.racksSet` cuenta intentos, no éxitos.** Si en el futuro vuelve a fallar un batch entero por otra razón, el summary mentirá igual. Pendiente: distinguir `racksOk` vs `racksAttempted`.

---

## 1.4.1: desarchive pre-enrich (Fix L2, 2026-05-21) — NO resolvió el síntoma visual; se mantiene como defensa en profundidad

> **⚠️ Nota de cierre post-validación.** Este fix **NO** arregla el bug visual reportado (specs tachadas en la línea de cotización cuando el PN está archivado). Ver sección **"Lección aprendida"** al final de esta entrada. Se mantiene en el código como **defensa en profundidad** — mutaciones de `SavePartNumber` / `ArchivePredictedInventoryUsage` / `AddParamsToPartNumber` sobre un PN archivado pueden tener side effects silenciosos (precedente: 1.3.3 Sterlingshield S huérfano). El "fix visual" del síntoma está **fuera del scope del applet** (es una contradicción inherente del diseño de Steelhead — ver lección).

**Problema.** El Fix L del 1.4.0 (archive de specs sentinel pre-quote) no resolvió el síntoma — las specs viejas siguieron apareciendo tachadas en la línea de cotización, incluso con quote completamente nueva (#139 archivada, corrida fresca con localStorage limpio y nombre nuevo). Repro reportada por el operador: PN id 3017160 en la quote nueva — al alternar el toggle "archived" del NÚMERO DE PARTE en la UI, las specs viejas desaparecían/reaparecían según el estado del PN.

### Causa raíz
Los 100 PNs del CSV "Schneider RG arch" ya estaban archivados en Steelhead. La clasificación los marcaba `status='existing'`, `wasArchived=true`. Como el CSV también pedía archivar al final (`part.archivado=true`), STEP 8 nunca empujaba a `pnsToUnarchive` (el `else if` de la línea 3858 jamás se ejecutaba), así que el PN pasaba **archivado de principio a fin**. Resultado: STEP 5 archive sentinel + STEP 6 enrich + `SaveManyPNP_Quote(autoGenerateQuoteLines:true)` corrían todos sobre un PN archivado, y el snapshot que la quote line capturaba al auto-generarse heredaba el estado archivado → todas las specs salían como "archivadas" aunque las del CSV fueran nuevas o las viejas hubieran sido archivadas correctamente por STEP 5.

### Solución
Insertar **STEP 4.5** que desarchiva todos los PNs `wasArchived` ANTES del STEP 5. STEP 8 ya re-archiva al final si el CSV lo pide (`part.archivado=true`) — el flujo queda idempotent: PN llega archivado → desarchive → enrich completo con PN activo → snapshot fresco → re-archive si CSV lo pide.

### Diseño
- Aplica en **ambos modos** (`COTIZACIÓN+NP` y `SOLO_PN`). Aunque el bug visible es el snapshot de la quote line, una mutación de SavePartNumber sobre un PN archivado puede ser silenciosa o tener side effects (caso K1 confirmado en 1.3.3 con predictivos huérfanos). Defensa en profundidad para ambos modos.
- Dedup por `existingId` con `unarchivePreSeen` para no pegar dos veces al mismo PN físico cuando dos filas del CSV apuntan al mismo PN.
- Pool concurrente `runPool` (default 5, reusa `concurrency.savePartNumber`). `withRetry` con backoff [1s, 2s, 4s] para HTTP 429/503/network.
- `bailIfStale` propagado para soportar el botón "Detener" del panel.
- Costo extra: ~1 `UpdatePartNumber` por PN archivado. Para una corrida típica Schneider con 100 PNs archivados, ~3-5s adicionales. Marginal vs el beneficio.
- Si la corrida muere a mitad de camino (post-desarchive, pre-STEP-8), los PNs quedan **desarchivados** hasta que el usuario reanude o re-archive manual. Trade-off aceptado vs el bug actual de specs tachadas.

### Cambios
- **`remote/config.json`:** bump `version` 1.4.0 → 1.4.1.
- **`remote/scripts/bulk-upload.js:VERSION`:** `1.4.0` → `1.4.1`.
- **`remote/scripts/bulk-upload.js:~2846`:** insertado bloque STEP 4.5 entre `existingPnFullCache` y `if (!isSoloPN)`. STEP 5 / 6 / 6a / 6b / 7 / 7b / 8 intactos.

### Plan de validación

**Validación visual (síntoma original):** ❌ CERRADO — el STEP 4.5 no resuelve el "specs tachadas en la línea" porque Steelhead renderiza en tiempo real (ver Lección aprendida). No re-probar este criterio.

**Validación de defensa en profundidad:** ✅ vale la pena confirmar antes de cargas grandes:
1. CSV "Corrida de prueba 100 NP RG arch" (100 PNs archivados, archivar al final). Verificar:
   - Modal de progreso muestra "Paso 4.5/9: Desarchive pre-enrich (100 PN(s))..." al inicio.
   - Consola loggea `STEP 4.5 desarchive pre-enrich: N/N OK`.
   - STEP 8 al final loggea `Archivado: 100 nuevos archivar, ...` y el PN queda archivado en Steelhead post-corrida.
   - Sin errores HTTP 500 sobre mutations a PNs archivados (que es justo lo que el STEP 4.5 previene).
2. CSV con PNs activos (no archivados): STEP 4.5 no debe loggear nada (`pnsToUnarchivePre.length === 0`). Sin overhead.
3. CSV mixto: PNs activos + archivados — solo desarchive los archivados.
4. Modo SOLO_PN con PNs archivados: confirmar desarchive + enrich + re-archive funcionando.
5. Test de robustez: matar la pestaña justo después del STEP 4.5 → PNs quedan desarchivados (esperado). Reanudar → STEP 8 los re-archiva.

### Files tocados
- `remote/scripts/bulk-upload.js:49` (VERSION) y `~2846` (STEP 4.5)
- `remote/config.json:2` (version)
- `docs/applets/bulk-upload.md` (esta entrada)
- `CLAUDE.md` (tabla índice 1.4.0 → 1.4.1)

### Lección aprendida (2026-05-21, post-validación con PN id 3017160)

**Steelhead renderiza las quote lines en tiempo real — NO usa snapshot estático.** Hipótesis verificada por el operador: con la quote ya creada y guardada, desarchivar manualmente el PN y recargar la página → las marcas de "archivada" en las specs de la línea desaparecen instantáneamente. Re-archivar el PN → reaparecen. Cada render de la línea consulta el estado vigente del PN y sus specs, no un snapshot capturado al momento del `SaveQuoteLines`.

**Implicación del modelo previo (1.4.0 + 1.4.1):**
- La hipótesis original del Fix L ("el snapshot de la quote line captura las specs vigentes al momento del SaveQuoteLines") era **incorrecta**. No hay tal snapshot.
- La hipótesis del Fix L2 ("el snapshot hereda el estado archivado del PN cuando SaveManyPNP corre sobre un PN archivado") **también era incorrecta** por la misma razón.
- El workaround manual histórico (desarchivar NP → editar línea → guardar → re-archivar NP) funcionaba porque entre el "guardar" y el "re-archivar", el operador alcanzaba a ver la línea con el PN activo. Pero al re-archivar, la línea vuelve a verse archivada — se aceptaba el comportamiento durante el flujo manual sin haberlo identificado como "render en tiempo real".

**Conclusión sobre el síntoma visual:**
- **Un PN archivado SIEMPRE se ve tachado en cualquier quote que lo referencie**, sin importar cuándo se creó la línea ni qué se haya hecho con sus specs. Es comportamiento intencional de Steelhead.
- Para que la cotización se vea "limpia", el PN tiene que quedar **desarchivado**. Pero el CSV pide archivar al final → contradicción visual inherente.
- No hay forma desde el applet de resolver esto sin cambiar el contrato del CSV (ej. introducir un toggle "no archivar PNs hasta validar la quote" — fuera de scope actual).

**Por qué se mantiene el STEP 4.5 igual:**
- Sí cubre un problema real, aunque distinto al original: `SavePartNumber` (y mutaciones afines) sobre un PN archivado puede tener side effects silenciosos. Precedente concreto: 1.3.3 documentó que el `Sterlingshield S` huérfano se creó porque `SavePartNumber.inventoryPredictedUsages` aceptó la mutación en un contexto que la UI manual no permitía borrar después.
- Con STEP 4.5 garantizamos que el enrich (STEP 5/6/6a/6b) corra siempre contra un PN activo, lo que elimina cualquier ambigüedad de "¿la mutation pasó o fue silencioso?".
- Trade-off: `~3-5s` extra por corrida con PNs archivados + ventana corta donde un crash mid-run deja PNs desarchivados. Aceptable.

**Recomendación operativa para el usuario:**
- Si necesitas validar la cotización "limpia" (specs no tachadas), desarchiva el PN antes de revisar y re-archívalo después. Ese ya era el workaround manual original — sigue siendo el único.
- Si el CSV pide archivar, el PN va a quedar archivado al final de la corrida y la línea se va a ver tachada. **No es un bug del applet; es comportamiento de Steelhead.**
- Para próximas corridas: si un cliente exige ver las quotes "limpias", coordina con el operador para validar quotes ANTES de marcar los PNs como archivados en el CSV (es decir, dos corridas: una sin archivar, validas, otra solo para archivar).

**Pendiente derivado (sin commit):** evaluar si vale la pena introducir un toggle en el modal del applet tipo "no archivar PNs al final de esta corrida (validación pendiente)" que sobreescriba `part.archivado=true` solo para esa ejecución. Bajo costo de implementación, beneficio claro para flujos de validación. No es urgente — el workaround manual es viable.

---

## 1.4.0: archive de specs sentinel pre-quote (Fix L, 2026-05-21)

**Problema.** Cotizaciones de PNs modificados mostraban specs **archivadas** en la línea (aparecían tachadas / con marker de "archivada"). El operador validaba manualmente y, para limpiar la línea de cotización, tenía que: (1) desarchivar el NÚMERO DE PARTE en otra pestaña, (2) abrir la cotización y dar click en "editar línea" (Steelhead lanza una llamada que refresca el snapshot y quita la spec archivada del display), (3) guardar la cotización, (4) re-archivar el NP. Reproducible en cada corrida con archive sentinel `spec=-`.

### Causa raíz
El enrichWorker (STEP 6) archivaba las specs vigentes **después** de `CreateQuote` + `SaveManyPNP_Quote` + `GetQuote` + `SaveQuoteLines`. El snapshot que arma la quote line al momento del SaveQuoteLines captura las specs vigentes del PN — específicamente las que aún no han pasado por `partNumberSpecsToArchive`. Cuando Steelhead refrescaba la UI, comparaba el snapshot vs el estado actual del PN y mostraba las specs como "archivadas". El workaround manual confirma el modelo: bastaba un trigger (edit-line + save) en un PN limpio para que el snapshot se reconstruya correctamente.

### Solución
Insertar **STEP 5 (pre-chunk-loop)** que archiva las specs sentinel **antes** del primer `SaveQuoteLines`. Cuando llega STEP 6, ya no hay specs vigentes que archivar → la rama `partNumberSpecsToArchiveIds` queda idempotent (no-op). El resto del enriquecimiento (params, dims, racks, customInputs) sigue corriendo después y no afecta el snapshot de la línea.

### Diseño
- Solo se ejecuta para PNs con `pnStatus.status === 'existing'` **y** algún `spec.name === '-'` en el CSV.
- Pool concurrente con `runPool` (default 5, configurable vía `concurrency.savePartNumber`).
- Reusa `existingPnFullCache` (poblada de cero si el cache estaba frío): `GetPartNumber` on-demand → SavePartNumber mínimo con SOLO `partNumberSpecsToArchive` poblado. Invalida la entrada del cache tras archivar para que STEP 6 vea el estado fresco.
- Solo aplica en modo NORMAL (`!isSoloPN`); SOLO_PN no genera cotizaciones, no tiene el bug.
- Costo extra esperado: ~1 GetPartNumber + ~1 SavePartNumber por PN con sentinel. Para una corrida típica (cientos de PNs con `-`) son ~30s adicionales. Marginal vs el beneficio de eliminar el workaround manual post-corrida.

### Cambios
- **`remote/config.json`:** bump `version` 1.3.3 → 1.4.0.
- **`remote/scripts/bulk-upload.js:VERSION`:** `1.3.3` → `1.4.0`.
- **`remote/scripts/bulk-upload.js:` (~línea 2846, principio del `if (!isSoloPN)`):** insertado bloque STEP 5. Se mantienen STEPs 6, 6a, 6b, 7, 7b, 8 intactos.

### Plan de validación pendiente
1. CSV con PN existing + `spec1=-` (sentinel "borrar todas las linked specs"). Verificar que la cotización se crea con la línea **sin** specs archivadas mostradas.
2. CSV con PN existing + `spec1=Y, spec2=-` (apply Y + archive el resto). Verificar que la línea muestra solo Y y nada archivado.
3. CSV sin sentinel — confirmar 0 overhead (`STEP 5` no debe loggear nada).
4. Confirmar `log("STEP 5 archive sentinel pre-cotización: N OK, M skip")` en consola.
5. Verificar que `stats.specsArchivedBySentinel` se incrementa correctamente (puede sumar dos veces si por algún motivo STEP 6 también archiva — defensa en profundidad pero no debería pasar).

### Files tocados
- `remote/scripts/bulk-upload.js:49` (VERSION) y `~2846` (STEP 5)
- `remote/config.json:2` (version)
- `docs/applets/bulk-upload.md` (esta entrada)
- `CLAUDE.md` (tabla índice 1.3.3 → 1.4.0)

---

## 1.3.3: archive real de predictivos huérfanos (2026-05-21)

**Fix K1.** STEP 6a ahora **archiva** (soft-delete) los predictivos cuyo CSV trae `-` en lugar de zerificarlos. Antes (1.3.1-1.3.2) se mandaba `UpdateInventoryItemPredictedUsage(microQuantityPerPart=0)` — el predictivo seguía listado en *Predicted Inventory Usage* del PN, solo con `0 (LTS)`. Caso real reportado: `Sterlingshield S (Antitarnish) (Materia Prima)` se quedó con 2728.8 LTS Total Predicted Usage después de una corrida donde el CSV traía `-`. La UI manual de Steelhead tampoco podía borrarlo (probablemente porque se había creado sin `treatmentId` desde una corrida previa via `SavePartNumber.inventoryPredictedUsages`).

### Causa raíz
El comentario del código (1.3.1, línea 3476) decía *"no hay mutation de archive de predictive usage en el scan; 0 los deja inertes"*. Eso **dejó de ser cierto** — el scan `2026-05-21_185409.json` capturó `ArchivePredictedInventoryUsage` (hash `985513e9b42027571b365453d96098d52e376031c881fbdda5fbf5a1c391dc3e`, 507 invocaciones, 0 errores). Input singular: `{input: {id, predictedInventoryUsagePatch: {archivedAt: ISO}}}`.

### Cambios
- **`remote/config.json`:** agregado hash + entrada `operations.ArchivePredictedInventoryUsage`. Bump `version` 1.3.2 → 1.3.3.
- **`remote/scripts/bulk-upload.js:VERSION`:** `1.3.2` → `1.3.3`.
- **`remote/scripts/bulk-upload.js:STEP 6a`:** se separan dos buckets — `predictedUpdates` (numérico, batch 20 vía `UpdateInventoryItemPredictedUsage`) y `predictedArchives` (dash granular, paralelo con pool 5 vía `ArchivePredictedInventoryUsage` singular). `archivedAt = new Date().toISOString()`. Errores van a `errors[]` para el reporte XLSX.

### Sobre la creación (Fix K2 NO necesario)
La **creación** sigue por `SavePartNumber.inventoryPredictedUsages` (insert-only, sin `treatmentId`). El scan también captura `SavePredictedInventoryUsagesWithCascade` que requiere `treatmentId`, pero validación operativa confirma que Steelhead acepta crear sin treatmentId **si el proceso del PN contiene al menos un treatment que use ese inventoryItem**. Ese predictivo después sí se puede archivar (vía la mutation que K1 incorpora). El problema histórico que dejó a `Sterlingshield S` huérfano fue de **input del operador**: meter el material en un PN cuyo proceso no contenía un treatment con ese inventoryItem → Steelhead lo guardó pero ni la UI manual permite borrarlo. No es algo que el applet pueda detectar sin replicar el árbol de procesos por PN, queda como lección operativa.

### Plan de validación pendiente
1. Subir CSV con `-` en BB-BJ para un PN que ya tenga ≥1 predictivo numérico, verificar que el predictivo desaparece de *Predicted Inventory Usage* (no que quede en 0).
2. Verificar que predictivos numéricos siguen funcionando sin regresión.
3. Confirmar `log("Predictivos archivados: N/N")` en consola.

### Files tocados
- `remote/scripts/bulk-upload.js:49,3463-3520` (VERSION + STEP 6a refactor)
- `remote/config.json:50` (hash) + entrada `operations.ArchivePredictedInventoryUsage` + `version`
- `docs/applets/bulk-upload.md` (esta entrada)
- `CLAUDE.md` (tabla índice 1.3.2 → 1.3.3)

---

## 1.3.2: perf + robustez resume (2026-05-21, deploy gh-pages PENDIENTE, validación en prod PENDIENTE)

Ocho fixes orientados a recortar el tiempo de corrida Schneider (proyección 5 hrs → ~2 hrs para 9k PNs) y eliminar el escenario donde un atorón a media corrida obliga a limpiar `localStorage` manualmente. Plan formal en `docs/superpowers/plans/2026-05-21-bulk-upload-1.3.2-perf.md`.

**Commits (main):** `44ac9b8` T1 · `eaaf5ca` T2 · `e9a1b1d` + `fdff954` T3 + cleanup · `b6a0412` + `3feb1cf` T4 + cleanup · `45bd02b` T5 · `eac1ec4` T6 bump.

### Fixes de performance (esperado ~50% reducción wall-clock)

- **C. `specsToApply` filtrado en PNs existing (`bulk-upload.js:enrichWorker`).** Pre-fetch `GetPartNumber` al inicio del worker cuando `status==='existing'` (no solo con archive sentinel), construye `alreadyLinkedSpecIds` Set, filtra `specsToApply` quitando las ya linkeadas. Sin esto el primer `SavePartNumber` siempre fallaba con `unique_constraint` en `partNumberSpec(pnId,specId)` → fallback strip1 quitaba `specsToApply` → 2× calls por PN existing. Con esto, primer `SavePartNumber` pasa limpio.

- **I. Invalidar `existingPnFullCache` después de `SavePartNumber` (`bulk-upload.js:enrichWorker`).** Sin esto, el cache que STEP 6b lee es el snapshot pre-enrich; cree que los params recién agregados no existen y manda `AddParamsToPartNumber` que devuelven 500 exclusion constraint. El cache fresco hace que `existingParamIds` cubra los params actualizados → `missing` se vacía → skip silencioso sin call espuria. Tres invalidaciones (primary + strip1 + strip2), todas guardadas por `if (pn.id)`.

- **D. STEP 6b paralelizado con `runPool` concurrencia 5 (`bulk-upload.js:STEP 6b`).** Antes el loop era secuencial: 100 PNs × varios specs × varios params × ~300ms ≈ 100s. Con pool 5: ~25s. Para Schneider 9k es el cambio más impactante (~2.5 hrs ahorradas). El `step6bWorker` hace cache-first read (poblado por Fix I), itera specs, filtra missing params contra `existingParamIds`, envía `AddParamsToPartNumber` uno a la vez con catch silencioso para `exclusion constraint`/`conflicting key`/`23P01`. Cleanup `fdff954` removió el `log("ya presente, skip")` que originalmente preservé del 1.3.1 — el plan pedía silent skip explícitamente para no spammear consola con N × M × PNs líneas en corridas de 9k+.

### Fixes de robustez resume

- **G. `resumeState = null` al inicio de `execute()` (`bulk-upload.js:~2217`).** `let resumeState = null;` (línea 134) es variable del IIFE (closure de módulo). Si una corrida entró al modal Reanudar, la SIGUIENTE corrida en la misma página la encontraba con datos viejos → `if (!resumeState)` línea ~2277 era false → no se creaba state limpio → chunk loop saltaba usando `completedChunks` heredado. **Bug observado 2026-05-21**: tras limpiar `localStorage` manualmente, las re-ejecuciones SEGUÍAN saltando el chunk 1/1 hasta que el usuario recargó la página. Fix simple: `resumeState = null;` justo después de `nextRunId()`.

- **B-resume. Reconstruir `pnLookup` desde quote existente cuando chunk está en `completedChunks` (`bulk-upload.js:~2857`).** Antes el chunk loop hacía `continue` ciego → `pnLookup` vacío → STEP 6/6a/6b skip silencioso → "Completado OK" con 0/0/0. Fix: `findExistingQuote` + `GetQuote` vía `queryWithFallback` para reconstruir el lookup; matching por `pn.name.toUpperCase()` con arrays + `arr.shift()` para duplicados name+customerId. Las write-ops (CreateQuote, SaveManyPNP, SaveQuoteLines, UpdateQuote) sí se saltan porque ya están aplicadas; solo el enrich corre. **Conocido (1.3.3):** si el usuario modificó la quote en Steelhead entre runs (renombró PN, borró+recreó), el matching falla con `warn` pero NO empuja a `errors[]` — la corrida termina "OK" con stats parciales sin alerta clara. Aceptable porque es estrictamente mejor que 1.3.1 (que dejaba todo en 0); a mejorar en 1.3.3.

### Fixes de UX

- **H. Espejear phase + progress + counters en el modal viejo `dl9-progress-overlay` (`bulk-upload.js:showProgressUI` + `setPanelPhase`/`setPanelProgress`/`setPanelCounters`).** El modal viejo tiene backdrop oscuro y tapa al panel flotante `sa-bu-panel`. Antes durante STEP 6 (que dura minutos) el modal viejo se quedaba en "Paso 6: Enriqueciendo PNs..." sin más output mientras el panel flotante (oculto) sí tenía progreso. Nuevo elemento `#dl9-live-progress` se actualiza desde los 3 setters vía helper `updateLiveProgressText()` con `"<phase> — X/Y   OK:N Reintentos:M Errores:K"` (cleanup `3feb1cf` corrigió los labels de inglés a español por convención del proyecto).

- **J. Cierre conjunto + id estable para `showResult` (`bulk-upload.js:~2210`).** Antes cada re-ejecución apilaba un nuevo modal de resultado sin id estable → click en CERRAR solo cerraba el último por id duplicado, dejando los anteriores vivos. Fix: `overlay.id = 'dl9-result-overlay'`; al entrar a `showResult`, remover overlays previos (progress + resultado anterior). `removeOverlay` ya es idempotente, así que las llamadas dobles son seguras.

- **Texto resultado:** `"1 cotizaciones creadas, 105 products"` → `"1 cotización creada con 100 PNs y 105 productos"` (singular/plural correcto + clarifica que son PNs, no productos). Acumulador `pnpItemsTotal += pnpItems.length` se suma por chunk dentro del chunk loop, antes del push de `completedChunks`.

### Conocidos NO resueltos (queda para 1.3.3)

- **`Racks: NaN`** en stats — observado en todas las pruebas. Variable inicializada como `NaN` o sumando `undefined`.
- **Mensaje stale en prefetch failure (Fix C).** El warn `"GetPartNumber prefetch X falló — caerá al flujo strip1"` es engañoso post-Fix-C: el strip1 ya no es el camino normal, solo fallback degradado. Reescribir cuando se toque el área.
- **`syncCounters.synced` no se mapea a `state.counters`** durante STEP 6b paralelo — durante esa fase el panel muestra los counters de STEP 6 (estáticos). Cosmético.
- **Doble lookup DOM en `setPanelPhase`** (`getElementById('dl9-live-progress')` se hace dos veces). Despreciable a 10-15 llamadas por corrida.

### Files tocados (deploy gh-pages PENDIENTE)

- MODIFICADO `remote/scripts/bulk-upload.js` — `VERSION 1.3.1 → 1.3.2`.
- MODIFICADO `remote/config.json` — bump `1.3.1 → 1.3.2`.
- MODIFICADO `docs/applets/bulk-upload.md` (este archivo).

### Plan de validación

1. Run sobre el mismo CSV "Corrida de prueba 100 NP RG arch" (100 PNs Schneider). Esperado: <2 min total. Modal live-progress muestra fase + counters en vivo. STEP 6b paralelo (5 a la vez). Sin 500s espurios. Sin `retry sin specs/optIn OK` (o muy pocos).
2. Test de robustez: recargar página a mitad de STEP 6 → relanzar mismo XLSX → modal "Corrida previa detectada" → REANUDAR → confirmar que reconstruye `pnLookup` desde quote existente y enrich se completa.
3. Test de re-ejecución sin reload: correr 100 PNs → cerrar modal de resultado → correr otra vez → verificar que NO se apilan modales (solo uno visible) y que el chunk NO se salta con `completedChunks` heredado (`resumeState` debe quedar en `null` al inicio).
4. Si todo OK → arrancar Schneider 9k con resume habilitado.

## 1.3.1: predictivos granulares + progreso STEP 6b + bookkeeping retries (2026-05-21, deploy `9d7437e` main / `5b2aaa2` gh-pages, validación en prod PENDIENTE)

Tres fixes derivados de la corrida 1.3.0 de Schneider donde el usuario reportó "atorada en Enriqueciendo PNs (pool 5)" con "muchos errores" en DevTools.

**E. Predictivos granulares por material (`bulk-upload.js:623-642`, `3239-3243`, `3358-3374`).** Antes (1.2.12-1.3.0) el sentinel "borrar predictivos" solo funcionaba si la columna BB=53 (primer material = Plata Fina) traía `-` — eso archivaba TODOS los predictivos del PN. Si ponías `-` en otra columna (Estaño/Níquel/Zinc/etc.) `gn(row, col)` colapsaba `-`→null indistinguible de celda vacía y se ignoraba. Ahora cada celda BB..BJ se evalúa en crudo: `-` archiva ese material individual (microQuantityPerPart=0 vía UpdateInventoryItemPredictedUsage); número > 0 lo upserta; vacío no toca. Se quita el wildcard BB=`-` — para borrar todos hay que poner `-` en cada columna que aplique.

**A. Progreso en STEP 6b "Sync params spec en PNs existentes" (`bulk-upload.js:3395-3417, 3479-3482`).** El loop secuencial de STEP 6b nunca llamaba `setPanelPhase` ni `setPanelProgress`, así que el panel quedaba congelado en `"Enriqueciendo PNs (pool N)"` con el contador del STEP 6 mientras procesaba 100+ PNs uno por uno (cada uno con varias calls AddParamsToPartNumber). Parecía atorada. Fix: cuenta candidatos primero, setea fase + total, e incrementa en cada iteración. Síntoma colateral observado: los `POST .../graphql 500 (Internal Server Error)` del Network panel son la forma como Steelhead reporta exclusion-constraint cuando el param ya existe — el código lo trata como skip silencioso (línea 3464-3466). Ruido visual en DevTools, no bug.

**B. `state.counters.retried++` junto a `retrySP++` en strip1/strip2 (`bulk-upload.js:3310, 3319`).** Antes el modal mostraba "Reintentos: 0" aunque la consola loggeara docenas de `"retry sin specs/optIn OK"`. Solo `withRetry` (red 429/503/network) sumaba al contador; los retries de unique-constraint (que son los que dominan cuando un PN existente se manda sin id) no. Ahora el modal refleja la realidad.

**Diagnóstico de fondo NO resuelto en 1.3.1 (queda para 1.3.2):**

- **🔴 BUG CRÍTICO de resume con `completedChunks` huérfano (descubierto 2026-05-21).** El chunk loop marca `completedChunks[cid].push(cIdx)` en línea 3025 al final del pipeline de creación de quote (CreateQuote + SaveManyPNP + GetQuote + SaveQuoteLines + UpdateQuote). **Pero el STEP 6 (enrich de PNs vía SavePartNumber + predictivos + specs sync) viene DESPUÉS del chunk loop**, así que si el usuario recarga la página o se atora durante STEP 6, el chunk queda marcado completo pero el enrich no terminó. Al reanudar: el chunk loop hace `continue` en línea 2854, `pnLookup` queda vacío, todos los `enrichWorker` regresan con `if (!entry) return` (línea 3133), terminan con 0 OK / 0 retry, y `execute()` marca `phase='done'` (línea 3825) sin haber hecho nada. Resultado en el modal: "Completado OK" con TODO en cero (incluso `Quote: ... (#null)` porque `primaryQuoteIdInDomain` no se setea). El usuario queda atrapado: la quote existe en Steelhead pero los PNs no se enriquecieron, y el resume key marcado `done` impide reanudar.
  - **Recuperación manual:** borrar todos los `sa_bulk_resume_*` del localStorage y relanzar el applet. Como los PNs ya están creados en Steelhead, la clasificación los detectará como `existing`, `findExistingQuote` encontrará la quote, modal modify/skip/create → MODIFY limpia PNPs viejos y re-aplica; esta vez STEP 6 sí corre.
  - **Fix para 1.3.2 (Opción B):** cuando el chunk loop detecta un chunk en `completedChunks`, en lugar de `continue` ciego: ejecutar solo `findExistingQuote` + `GetQuote` para reconstruir `pnLookup` y `productByName` SIN volver a hacer SaveManyPNP/SaveQuoteLines/UpdateQuote (porque ya están aplicadas). Después dejar que el flujo siga normal al STEP 6 con pnLookup poblado.
  - **Alternativa Opción A (descartada):** mover el `push` de completedChunks a después del STEP 6. Más limpio conceptualmente pero requiere trackear "chunk parcialmente terminado" lo que complica la recuperación cuando el enrich falla a mitad.
- **TODOS los PNs caen en strip1** durante STEP 6 enrich (`retry sin specs/optIn OK`). El primer `SavePartNumber` choca con unique-constraint (probablemente name+customerId) → strip1 pasa. Hipótesis: `entry.pn.id` no se está pasando al `pnInput` cuando el PN es `existing`, por lo que el backend lo trata como CREATE. Efecto: 2x calls contra el server, ~50% del tiempo de STEP 6 es desperdicio. Necesita investigación específica de `pnLookup` / `pn.id` propagation.
- **STEP 6b pool concurrente** (D del plan). Después de A queda menos urgente — primero confirmar que A muestra progreso decente en prod.
- **`montoMinimo`:** el usuario confirmó que `delete ci.DatosPlanificacion.montoMinimo` SÍ borra del backend tras reload de la página. Steelhead aplica REPLACE en `customInputs` de SavePartNumber, no MERGE. Fix F propuesto (mandar `null` explícito) NO se aplicó.



## 1.0.0: hardening para corrida masiva de 18k filas (2026-05-18, deploy `18a453e` main / `4e91ffe` gh-pages, validación en prod PENDIENTE)

Refactor mayor del applet `bulk-upload.js` (1,709 → 2,427 LOC, +844 / –104). Aplica 7 fixes mínimos para sostener una corrida de Schneider Electric MX – Planta Rojo Gómez (>9,000 filas COTIZACIÓN+NP) sin perder integridad, más chunks de SOLO_PN de 2,000 filas para los otros ~79 clientes. Plan completo en `~/.claude/plans/ahora-necesito-regresar-a-frolicking-goblet.md`.

**Shape real de la carga (18k filas, división en 4 cargas):**

| # | CSV | Modo | Tamaño | Estrategia |
|---|---|---|---|---|
| 1 | `schneider-activos-2025.csv` | COTIZACIÓN+NP | ~5,000 filas | Single run, sin chunks |
| 2 | `schneider-archivados-2023-24.csv` | COTIZACIÓN+NP | ~4,000+ filas (LAST_ORDER) | Single run, sin chunks |
| 3 | `resto-activos.csv` | SOLO_PN | ~3-4k filas | Chunks de 2,000 |
| 4 | `resto-archivados.csv` | SOLO_PN | resto | Chunks de 2,000 |

**Trampa crítica conocida:** la opción `modify` del modal de conflicto de cotización **borra todos los PartNumberPrices previos** y reinserta desde el CSV (`bulk-upload.js:996-1000`). Por eso Schneider NO se puede chunkear — un segundo chunk borraría el primero. Cada cotización Schneider debe correr completa en un solo run.

**7 fixes aplicados:**

1. **Pool concurrente para `SavePartNumber` enrich** (1.5-2.5 h → 15-30 min para 9k PNs). Patrón `runPool(items, worker, concurrency, onProgress, myRunId)` portado de `spec-params-bulk.js`/`process-deep-audit.js`. Concurrencia 5 (config `steelhead.domain.bulkUpload.concurrency.savePartNumber`).
2. **Paginación real de `AllPartNumbers` en `checkPNExistence`** (`first: 200`, cap `maxResults: 1000`, loop `while (hasMore && !foundExact)`). Esta es la única defensa contra duplicados silenciosos cuando `searchQuery` matchea >50 PNs del cliente — es el mismo síntoma del bug `b4ccc7d` (2026-04-08) disfrazado.
3. **Cancellation token + panel con botón "Detener"**. `state.runId` monotónico + `nextRunId()` + `isStale(myRunId)` + `bailIfStale(myRunId)` + `BailError`, propagado a todos los loops async y al `withRetry` helper. Patrón idéntico al de `process-deep-audit`.
4. **Preview paginado del modal** (sustituye `<tr>` por PN interpolado en `innerHTML` — 9k filas congelaba Chrome). Conteos agregados arriba (X nuevas, Y existentes, Z forzadas), tabla con paginación cliente-side `PAGE_SIZE = 100`, filtros por status + cliente, `selected` Set persistente entre páginas. **No-fix:** XSS via `innerHTML` queda pendiente (item 2 del audit pre-producción global).
5. **Retry-with-backoff global `[1s, 2s, 4s]`**. Helper `withRetry(fn, label, myRunId, delaysMs)` que respeta cancelación entre intentos y solo reintenta en HTTP 429/503/network. Para `unique_constraint` mantiene la lógica progresiva existente. Aplicado en `SavePartNumber` (ambas fases), `SaveManyPNP`, `CreateQuote`, `SaveQuoteLines`, `UpdateQuote`, `UpdatePartNumber`, `SavePartNumberRackTypes`, `UpdateInventoryItemPredictedUsage`.
6. **Pool concurrente para archivado final** (mismo `runPool`, concurrencia 5). Combina `pnsToArchive` + `oldPnsToArchive` + `pnsToUnarchive` en una sola pasada.
7. **Resume tras crash** con `localStorage` (NO `chrome.storage.local` — MAIN world no expone `chrome.*` confiablemente). `runKey = sha256(csvText)` como handle. Schema en `localStorage['sa_bulk_resume_<runKey>']` con `phase, completedPNs[], failedPNs[], quoteId, quoteAction, lastUpdatedAt`. Índice en `localStorage['sa_bulk_resume_index']` con purga ≥ 7 días. Modal "Detecté corrida previa, ¿Reanudar / Empezar de cero / Cancelar?" al inicio de `execute()` cuando matchea. Persiste cada 50 PNs (no por cada uno) + en cada cambio de fase.

**Lecciones del ciclo:**

- **`chrome.storage.local` NO funciona en MAIN world.** El plan original pedía `chrome.storage.local` pero la inyección MAIN no expone `chrome.*` APIs de forma confiable. Pivot a `localStorage` con prefijo `sa_bulk_resume_` + índice separado. Mismo patrón que `paros-linea`, `invoice-auto-regen`, `bill-autofill`. Límite 5MB por origen es holgado (~300KB JSON para 9k entries). **Regla derivada**: cuando un plan de applet pida persistencia y el applet corra MAIN world, usar `localStorage` desde el principio — `chrome.storage.local` se reserva para applets que corran en el background.js o que tengan `chrome.runtime.sendMessage` round-trip.
- **`myRunId` debe declararse en el scope donde arranca cada fase.** El primer commit del Fix 1 quedó con `runPool(items, worker, 5, cb, myRunId)` referenciando una variable que nunca se declaró en `execute()`. Fixed agregando `const myRunId = nextRunId(); showPanel(); setPanelPhase('Iniciando...');` al inicio del `try` de execute, y pasando `myRunId` a TODOS los helpers async que arranque la fase (incluyendo `checkPNExistence(parts, myRunId)`). Lección: cuando portas el patrón de cancellation token de un applet existente, **el primer paso es capturar `myRunId` en el scope público de `execute()`**, no en cada loop interno. Si está disperso, hay funciones que silenciosamente no aceptan cancelación.
- **`enrichWorker` con resume skip requiere stubs tempranos.** Cuando aplicas fixes en orden numérico (1→2→3...), el Fix 1 (pool concurrente para enrich) puede referenciar `resumeState` y `persistResumeState()` que solo se implementan en Fix 7. Para evitar `ReferenceError` durante desarrollo iterativo, agregar **stubs** (`let resumeState = null;` + `async function persistResumeState() {}`) inmediatamente después de `state` y reemplazarlos en Fix 7. Patrón aplicable a cualquier refactor multi-fix donde fixes posteriores definen helpers que fixes anteriores usan: stub-first, real implementation later.
- **PN unique identifier es `(name.toUpperCase(), customerId)`.** Para el `resumeCompletedSet` la clave es `${part.pn.toUpperCase()}|${part.customerId}`. No `name` solo — dos clientes pueden tener PNs con el mismo nombre. No `name` lowercase — Steelhead trata uppercase como canónico (la mutación `SavePartNumber` también upper-casea).
- **Defensive config defaults.** El applet lee `bulkCfg()` que devuelve defaults si la sección `steelhead.domain.bulkUpload` no existe en `config.json`. Importante para no romper deploys antiguos durante el rollout. Patrón: cada nueva sección de config tiene un accessor con defaults inline.
- **Patrón "deploy de bulk-upload": stash + checkout + cp + commit + push + restore.** Modificaciones tempranas al `.xlsm` bloquearon el checkout de `gh-pages`. Workflow: (1) `git stash push -u -m "wip" -- Plantilla_Cotizaciones_y_NP_v84_1.xlsm` para sacar el .xlsm del index; (2) `git checkout gh-pages`; (3) `cp ../main-checkout/remote/scripts/bulk-upload.js scripts/bulk-upload.js && cp ../main-checkout/remote/config.json config.json`; (4) `git add scripts/bulk-upload.js config.json && git commit -m "deploy: bulk-upload 1.0.0 ..."`; (5) `git push origin gh-pages && git checkout main && git stash pop`. **Verificación crítica**: `git diff HEAD:remote/scripts/bulk-upload.js gh-pages:scripts/bulk-upload.js` debe dar 0 bytes de diferencia.

**Configuración nueva en `remote/config.json`:**
```json
"bulkUpload": {
  "concurrency": { "savePartNumber": 5, "archive": 5 },
  "retry": { "delaysMs": [1000, 2000, 4000] },
  "paging": { "allPartNumbers": { "first": 200, "maxResults": 1000 } },
  "preview": { "pageSize": 100 },
  "resume": { "maxEntries": 20, "purgeAgeDays": 7 }
}
```

**Files tocados (deploy `18a453e` main / `4e91ffe` gh-pages):**
- MODIFICADO `remote/scripts/bulk-upload.js` (+844 / –104 LOC; VERSION bumped a `'1.0.0'`).
- MODIFICADO `remote/config.json` — bump 0.9.0 → 1.0.0; nueva sección `steelhead.domain.bulkUpload`.
- `extension/background.js` SIN cambios (el handler `case 'run-csv'` en `background.js:324` ya estaba).

**Estado de deploy:**
- `main`: `18a453e` — **pushed** a remote.
- `gh-pages`: `4e91ffe` — **pushed** a remote.

**Plan de validación PENDIENTE** (a ejecutar antes del primer run real de Schneider):

*Etapa 0 — Sanity check de hashes:* confirmar que los hashes de persisted queries en `remote/config.json` siguen vivos (AllPartNumbers, SavePartNumber, SaveManyPartNumberPrices, CreateQuote, SaveQuoteLines, UpdateQuote, UpdatePartNumber, AllQuotes, SavePartNumberRackTypes, UpdateInventoryItemPredictedUsage, AddParamsToPartNumber). Si alguno responde HTTP 400 con `"Must provide a query string."`, aplicar el playbook 60-segundos.

*Etapa 1 — Test unitario con CSV de 10 filas reales:*
1. Construir CSV con 10 filas representativas extraídas del archivo Schneider grande.
2. Correr modo COTIZACIÓN+NP en cotización temporal "TEST-Schneider-2026-05-19".
3. Verificar: preview paginado renderiza sin freeze, botón Detener funciona, pool concurrente respeta `concurrency.savePartNumber = 5` (revisar Network tab en DevTools), `AllPartNumbers` paginado detecta correctamente PNs existentes incluso con >50 matches del searchQuery, runKey se guarda en `localStorage` y se purga al `phase: 'done'`.
4. Archivar la cotización TEST y verificar que el archivado final con pool funciona.

*Etapa 2 — Test medio con CSV de 100 filas:*
1. Mismo CSV-test pero con 100 filas. Cotización temporal distinta.
2. **Crítico: validar flujo de resume.** Iniciar corrida → cerrar tab a los ~30s → reabrir Steelhead, recargar extensión → relanzar el MISMO CSV → modal de resume aparece → reanudar → completa sin duplicar PNs.
3. Conteos esperados: cotización con 100 PNPs, 0 duplicados, 0 errores no esperados.

*Etapa 3-5 — Runs reales:* Schneider activos 2025+ (single run), Schneider archivados 2023-24 (single run), chunks SOLO_PN 2k cada uno. Mirar Network tab para verificar que retry absorbe 429/503 esporádicos y el contador de "Reintentos" en el panel los reporta.

## `bulk-upload` 1.1.0 + 1.2.0: dedup QuoteIBMS + Pase 3 con comparación inline (2026-05-20)

**1.1.0** (plan `docs/superpowers/plans/2026-05-20-bulk-upload-quoteibms-dedup.md`, T0-T14, deploy `6dac175`):
- **Pase 1 (autoritativo):** match por `customInputs.DatosAdicionalesNP.QuoteIBMS`. Resuelve renombres del PN (mismo IBMS, nombre nuevo → MODIFY al PN viejo).
- **Pase 2 (composite):** `(customerId, name, metalBase, acabadosOrdenados)` con regla anti-colisión: si ambos IBMS no-vacíos y distintos, cae a Pase 3 en vez de MODIFY ciego.
- **Pase 3 (near-match):** hasta 3 candidatos por nombre exacto, ordenados por matchScore (acabados compartidos + metalBase + IBMS preference + id asc). El usuario decide con dropdown.
- **Blacklist de acabados:** `SMY, STX, SXC, SRG, SCM, SQ1, SQ2, NP desconocido, En desarrollo, Muestras, Lote, Obsoleto` se ignoran al construir el composite (etiquetas operativas, no acabados químicos).
- **MODIFY overwrites everything** desde el CSV (no merge). Esto es por diseño del flujo de "actualización masiva" de Schneider.
- **Auto-detect dual-mode:** `parts.length > massiveThreshold` (default 1000) → modo masivo (prefetch global de PNs del cliente, ~250 queries); ≤1000 → modo día (on-demand AllPartNumbers searchQuery por PN).
- **Reporte XLSX** con 3 hojas: Resumen (stats por pase), Decisiones Pase 3 (auditoría línea por línea), Errores.
- **Resume schema extendido** con classifications[] para reanudar tras crash sin re-clasificar (cache caliente del prefetch sobrevive en localStorage).

**1.2.0 (R1-R5, deploy `<NEW>`):** UX refinement del Pase 3 driven por feedback del usuario:
- **Default invertido:** Pase 3 con candidatos defaultea ahora **MODIFY al top match** (era NEW por defecto). El usuario puede override en el dropdown a otro candidato o a "🆕 Crear nuevo PN".
- **Comparación inline visible:** cada fila Pase 3 muestra debajo del dropdown:
  - Fila CSV: `📄 CSV — metal:CU · etiq:[NIQ,CRO] · proc:niquelado-cromado · IBMS:Q1`
  - Fila candidato seleccionado: `🎯 #ID — metal:AL · etiq:[NIQ] · proc:niquelado · IBMS:Q2`
  - La fila candidato se actualiza al cambiar el dropdown (re-render in-place)
- **Lazy fetch de specs:** botón `📋 specs` por fila despliega panel comparativo con specs del CSV (instantáneo) + specs del PN candidato (lazy fetch a `GetPartNumber`). Cache module-level `Map<id, {state, specs}>` evita refetch.
- **AllPartNumbers ya expone `processNodeByDefaultProcessNodeId.name`** sin tocar hash; `extractPNShape` lo guarda en `processName` para mostrarlo inline.
- **userOverride semántica nueva:** `null` = default (top match), `numero` = override a otro candidato, `'__new__'` = override explícito a NEW.
- **generateRunReport** ahora usa `s.status === 'existing'` (no `s.userOverride != null`) para decidir MODIFY vs NEW. Stats de Resumen distinguen 3 sub-casos del Pase 3: default top match / override otro / override Crear nuevo.

**Hash rotado en 1.2.0:** `GetPartNumber` 55bf9e21... → 60bee2e1... (síntoma idéntico al playbook de "rotación silenciosa": HTTP 400 `"Must provide a query string."` con el hash viejo en cold start; scan fresh muestra mismo shape con hash nuevo y HTTP 200).

**Lecciones del ciclo 1.2.0:**
- **UX matters en Pase 3.** El plan original (1.1.0) cumple el spec funcional pero el usuario lo encontró friccional en uso real: tener que clickear cada dropdown para decidir manualmente cuando había un top match razonable era doloroso para CSVs de cientos de filas. El refactor a default MODIFY ahorra clicks; los inline previews + lazy specs hacen el override decision una operación de segundos en lugar de tener que abrir cada PN en pestañas separadas.
- **Re-scan antes de adivinar deprecación.** `GetPartNumber` parecía deprecado (errores 400 en cold start), pero scan fresh confirmó rotación (hash distinto, mismo shape, HTTP 200). El playbook `Persisted queries deprecadas` aplica: NO asumir deprecación sin re-scanear. Lección reforzada de v0.5.7 y v0.6.24.
- **AllPartNumbers ya trae el processName.** Antes de bumpear su hash, verificar la query nativa: muchos campos "nice to have" ya viajan en la respuesta porque el UI los necesita en otros flujos. `n.processNodeByDefaultProcessNodeId.name` no requirió tocar nada en el config — solo agregar la propiedad en `extractPNShape`.
- **Lazy fetch + cache module-level vs prefetch global.** Para campos opcionales que el usuario consulta poco frecuentemente (specs en R4), lazy fetch on-demand + cache por PN es más eficiente que prefetch global de specs durante la clasificación. El cache vive en el IIFE del applet (no en state.runState), así sobrevive entre clics del usuario en distintas filas pero no entre reloads — patrón aceptable porque el usuario raramente reabre el mismo preview.

**Files tocados 1.2.0 (deploy `<NEW>`):**
- MODIFICADO `remote/scripts/bulk-upload.js` — VERSION 1.1.0 → 1.2.0, default Pase 3 MODIFY, csvLabels/csvMetalBase/csvIBMS/csvProceso/csvSpecs en row, dl9-p3-wrap + selrow + csv + cand + specs UI, `fetchCandidateSpecs` + cache, `generateRunReport` con 3 sub-casos.
- MODIFICADO `remote/config.json` — bump 1.1.0 → 1.2.0, rotación `GetPartNumber` hash.
- MODIFICADO `tools/test/bulk-upload-helpers.test.js` — Casos 6/anti-colisión actualizados al nuevo default MODIFY.

**Plan de validación 1.2.0 (USUARIO):** correr CSV de prueba con 3-5 PNs que caigan en Pase 3 (mismo nombre, distinto metalBase o IBMS). Verificar:
1. Dropdown abre con el top match preseleccionado (no "Crear nuevo").
2. Las dos líneas inline (📄 CSV, 🎯 candidato) muestran metal/etiq/proc/IBMS correctamente.
3. Cambiar a otro candidato actualiza la línea 🎯 in-place.
4. Cambiar a "🆕 Crear nuevo" pinta verde "se creará un PN nuevo".
5. Click `📋 specs` carga las specs del candidato sin freeze (cache, re-clic instantáneo).
6. Sin candidatos parecidos (Caso 7) → fila no entra a Pase 3, queda como NEW limpio.

## `bulk-upload` 1.2.11: 6 bugs de producción + UI override de archivado (2026-05-21, deploy PENDIENTE)
Ciclo F+H sobre el applet. F1/F2/F3 cerraron temas heredados (dedup strict-match en alternates, colores reales de chips CSV). H1-H8 son los 6 bugs reportados por el usuario tras correr en producción un CSV con varias filas que comparten `(name, customerId)` (Schneider Electric México con 9k filas):

| Bug | Causa raíz | Fix (H) |
|---|---|---|
| A: NEW + `archivarAnterior=true` se re-crea cada corrida (loop) | No había forma de ver/override que se iba a archivar | H5 toggle global + checkbox per-row + H6 lectura desde state |
| B: Specs anteriores NO se archivaban en MODIFY | Cache stale entre iteraciones de duplicados (Map `${name}|${cust}` colapsa) | H2 maps por rowIdx |
| C: Rack Type fantasma cargado a PN sin rack | `pnLookup` colapsado: la segunda iteración del duplicado escribe sobre la primera | H2 + H7 dedup por `(rackTypeId, pn.id)` |
| D: Predictive Inventory combina dos PNs | Mismo problema que C | H2 |
| E: Línea 5 sin productos, línea 6 con ambos | `SaveQuoteLines` itera por `${name}|${cust}` → mismo `ql.id`, idsToDelete stale | H4 SaveQuoteLines per-rowIdx |
| F: PN físico con Custom Inputs vacíos y solo SRG/SCM | `SavePartNumber` enrich llamado 2 veces sobre mismo pn.id; customInputs/labels replace en lugar de append | H3 capa A/B serializada |

**Premisa crítica corregida en este ciclo:** Steelhead **permite múltiples PartNumbers con mismo `(name, customerId)`** — son PNs físicos distintos con mismo nombre, distinguidos solo por id interno. La unique constraint que dispara error es **per-call**: dentro de un mismo `SavePartNumber` request batch, no puedes crear dos rows. Pero serializando llamadas (Capa A primero todos los únicos en paralelo, Capa B segundos/terceros duplicados en serie), sí crea N PNs físicos con el mismo nombre. Esto significa que **forzar las filas duplicadas del CSV a NEW colapsadas era el bug** — el clasificador (Pase 1/2/3) debe decidir cada fila por separado y respetar IBMS matches que apunten a PNs físicos distintos.

**Decisión arquitectónica clave H2:** las claves de `newPnIds` y `pnLookup` cambian de `${name}|${customerId}` a `rowIdx` (índice en `parts[]`). Side-effect: hay que mantener un `lineNumberToOrigIdx: Map<lineNumber, rowIdx>` para reconectar el output de `SaveManyPNP` (que devuelve `qpnp.lineNumber`) con la fila original del CSV.

**Capa A/B en STEP 2a (H3):**
```js
// Agrupa newOrDupParts por (name, customerId).
// Capa A = primer elemento de cada grupo (corren en paralelo con pool).
// Capa B = segundos/terceros (corren en serie, después de Capa A).
const seenNameCust = new Map();
for (let j = 0; j < newOrDupParts.length; j++) { /* ... */ }
const capaA = [], capaB = [];
for (const indices of seenNameCust.values()) {
  if (indices.length === 1) capaA.push(indices[0]);
  else { capaA.push(indices[0]); for (let n = 1; n < indices.length; n++) capaB.push(indices[n]); }
}
const orderedJs = [...capaA, ...capaB];
// Iterar orderedJs secuencialmente (en este patch — concurrencia para A puede agregarse después)
```

**UI override H5 (decidido con el usuario, "Ambos"):**
- **Toggle global** en el header del preview "🗄️ Archivar PNs viejos (CSV)" (default ON). Apaga = ninguna fila archiva (blanket override). Set/reset `state.archiveGlobal` en cambio.
- **Checkbox per-row** "🗄️ Arch ant" en la celda Acción solo para filas `forceDup` con `archivarAnterior=true` en el CSV. Set `parts[idx].archiveOverride = true|false`. Si el valor coincide con el global, se borra del part para que vuelva a seguir el global.
- **Chip "🔄 DUP n/m"** junto al PN cuando la fila es duplicado interno del CSV. Solo informativo — el classifier ya decide cada fila por separado.

**STEP 8 archive flow (H6):**
```js
const archiveGlobal = (state.archiveGlobal !== false); // default true
for (let i = 0; i < parts.length; i++) {
  const csvWantsArchive = !!part.archivarAnterior;
  const rowOverride = part.archiveOverride; // boolean | undefined
  const willArchive = (rowOverride === true) || (rowOverride === undefined && csvWantsArchive && archiveGlobal);
  if (status.status === 'forceDup' && willArchive && status.existingId) { /* push to oldPnsToArchive */ }
}
```
Tres niveles de override (en orden de precedencia: per-row > global > CSV default):
- `archiveOverride === true` → archiva siempre (aunque global esté off)
- `archiveOverride === false` → no archiva nunca (aunque CSV diga true)
- `archiveOverride === undefined` → sigue `archiveGlobal && csvWantsArchive`

**Dedup en STEP 7 (racks) y STEP 8 (archive)**: ahora la iteración por `parts[]` puede tocar el mismo pn.id N veces (cuando dos filas del CSV apuntan a MODIFY al mismo PN). Para evitar requests redundantes, cada loop tiene su `Set` de seen: `archiveSeen`, `oldArchiveSeen`, `unarchiveSeen`, `rackInSeen` (este último con clave `${rt.id}|${pn.id}`).

**Lecciones clave del ciclo:**

- **Maps key collapse es un bug silencioso.** El refactor 1.2.10 → 1.2.11 demostró que cualquier `Map<"${name}|${customerId}", ...>` se rompe cuando el CSV tiene duplicados internos legítimos. La cura es **rowIdx siempre** que el ámbito sea per-row, y mantener una `Map<lineNumber, rowIdx>` cuando hay un bridge entre el output del server (que usa lineNumber) y la fila origen. Aplicable a cualquier futuro applet que itere `parts[]` y haga lookup sobre identidad-natural.

- **El tradeoff "informar visualmente" vs "forzar collapse" tiene una respuesta clara: informar.** Mi primer instinto en H1 era colapsar las filas duplicadas en una sola NEW. El usuario me corrigió: "esto aplica sólo si no hizo match directo con quote, porque varios NP con mismo nombre pueden tener quotes distintas". O sea: el clasificador conoce mejor que una heurística de "todas igual" — si una fila duplicada tiene IBMS match, debe MODIFY a SU PN específico; si otra no tiene match, debe crear NUEVO. La UI hace el chip "🔄 DUP n/m" para que el operador valide la decisión, pero la lógica respeta cada fila.

- **`state` es accesible desde funciones lambda dentro del IIFE.** El módulo es un IIFE singleton, así que `state.archiveGlobal = checked` desde un event handler del preview persiste para cuando STEP 8 lo lea. No hace falta `Promise` callback ni context object pasado a `showPreview()`. Limitación: el state se resetea en `nextRunId()`, así que si el usuario cancela y reanuda, el toggle vuelve a default ON — ok, es lo esperable.

- **Sentinel coherente en checkbox per-row.** Para que el override sea "limpio", uso 3 estados: `undefined` (sigue global+CSV), `true` (explícito archive), `false` (explícito skip). Si el checkbox cambia a un valor que coincide con el default, lo borro de `parts[idx]` con `delete` — así el resume serialization no carga overrides ruidosos que el operador nunca quiso fijar.

- **Tests de regresión documentan el bug.** El test `1.2.11 H2 contraste — Map<"name|cust",...> SÍ colapsa (el bug que arreglamos)` reproduce el patrón roto y afirma `last-write-wins: fila 0 (1001) se perdió`. Si alguien futuro vuelve a usar la key compuesta, este test falla apuntando exactamente al motivo.

**Files tocados:**
- MODIFICADO `remote/scripts/bulk-upload.js` (~+800 LOC sobre 1.2.10; VERSION ya estaba en `'1.2.11'` desde F1/F2/F3, no se re-bumpea).
- MODIFICADO `remote/config.json` (`version: 1.2.10 → 1.2.11`, `lastUpdated: 2026-05-21`).
- MODIFICADO `tools/test/bulk-upload-helpers.test.js` (+8 tests H1/H2/H5; total 45 tests pasando).

**Plan de validación PENDIENTE (USUARIO):**
1. **Sanity**: cargar CSV pequeño con 3-5 filas únicas (sin duplicados internos). Verificar que no hay regresión vs 1.2.10 — el chip "🔄 DUP" NO aparece y el toggle global rige.
2. **Duplicados con IBMS distinto**: CSV con 2 filas mismo PN+cliente, IBMS distintos → ambas deben aparecer con chip "🔄 DUP 1/2" y "🔄 DUP 2/2", clasificador decide MODIFY a IDs físicos distintos. La cotización resultante debe tener 2 líneas, cada una con su PN, con sus productos correctamente asignados.
3. **Duplicados sin IBMS match** → Capa A/B serializa la creación de NEW; ambos PNs deben aparecer en Steelhead con id distinto pero mismo nombre+cliente.
4. **forceDup + archivar anterior**: una fila con `archivarAnterior=true` que entra a forceDup → mostrar checkbox "🗄️ Arch ant" marcado por default. Desmarcar → tras Ejecutar, el PN viejo NO se archiva. Re-correr el mismo CSV → no se crea otro PN (porque no se archivó el primero).
5. **Toggle global off**: prender el toggle, todos los checkboxes per-row se desmarcan visualmente. Apagar = ninguno archiva.
6. **Override per-row con global off**: con toggle global apagado, marcar manualmente un checkbox per-row → ese PN sí se archiva aunque el global esté off.
7. **Specs archivadas en MODIFY**: PN existente con specs A/B/C, CSV trae specs B/D → al ejecutar, A y C se archivan, B se conserva, D se agrega (validación del archive sentinel de 1.2.5 que se rompía con el bug B).
8. **Rack Type sin dato en CSV**: PN duplicado, una fila con Rack=PalmTree, otra con Rack vacío → el PN físico con rack vacío NO recibe Rack Type alguno (validación del bug C).
9. **Predictive Inventory sin combinar**: dos PNs duplicados con consumos predictivos distintos → cada PN físico debe tener solo SU consumo (validación del bug D).

## `bulk-upload` 1.2.12: Opción B (Pase 1/2 ven archivados) + sentinel `-` predictives + montoMinimo strip + getter `__state` + bitácora Bug 2 (2026-05-21, deploy PENDIENTE)
Ciclo de hotfixes encima de 1.2.11 sin redeploy intermedio. Cinco cambios concretos:

**1. Pase 1 + Pase 2 ven archivados (rompe el loop de auto-archivado por re-corrida con misma QuoteIBMS).**

Antes: `classifyOnePN` filtraba `archivedAt` de `pnsForCustomer` ANTES de cualquier pase, así que un PN con QuoteIBMS=Q1 auto-archivado por la corrida anterior era invisible para el classifier en la siguiente. Resultado: Pase 1 no encontraba match → caía a Pase 3 sin candidatos → NEW → si la fila traía `archivarAnterior=true`, archivaba el nuevo PN también → loop infinito de duplicados con misma IBMS.

Ahora (opción B): Pase 1 y Pase 2 buscan sobre `allPns` (incluye archivados). Pase 3 sigue limitado a `activePns` para no ensuciar el dropdown near-match con históricos. Cuando un archivado matchea, el resultado lleva `wasArchived: true` y `confidence` con suffix `-desarchiva` (`ibms-exacto-desarchiva`, `composite-exacto-pn-sin-ibms-desarchiva`, etc.). Este suffix se strippe en `dedupModifyTargets.confRank` para que el ranking sea el mismo que el de su variante activa.

El **desarchivado real** no requiere código nuevo: STEP 8 ya tenía `pnsToUnarchive.push({...})` cuando `pnStatus[i].status === 'existing'` y `UpdatePartNumber, archivedAt: null` se intentaba sobre TODOS los existing (silencioso si ya estaba activo). Con el cambio del classifier, ahora también incluye archivados correctamente. UI muestra chip "🔓 desarch" junto al nombre del PN en el preview.

**Razonamiento de la opción B vs A vs C** (decisión del usuario): A (sólo Pase 1) habría dejado el composite con el mismo bug si el cliente no usa IBMS o lo deja vacío. C (todos los pases) ensucia Pase 3 con archivados de hace años que nadie quiere revivir. B captura los dos identificadores fuertes (IBMS único + composite exacto) sin meter ruido a la decisión near-match.

**2. Bug 1A — sentinel `-` en BB (Predictive Inventory) borra usages existentes.**

Antes: `gn()` (parseFloat) colapsaba `-` a null indistinguible de celda vacía, así que `predictiveUsage` quedaba `[]` cuando el CSV traía dashes y el sentinel `predAreDash` nunca se disparaba. Los predictives viejos persistían silenciosamente.

Ahora: `bbRaw = g(row, 53)` se lee en CRUDO (antes de `gn`); si es `'-'`, se inyecta un placeholder `{ inventoryItemId: PREDICTIVE_MATERIALS[0].inventoryItemId, usagePerPart: '-', name: ... }` que `predAreDash`/`predIsDash` detectan correctamente. STEP 6a extendido: cuando `predIsDash`, en lugar de `continue` (que saltaba el PN), itera `exMap.values()` y agrega un patch `{ id: exId, microQuantityPerPart: 0, inventoryUsageLowCodeId: null }` por cada existente. Workaround necesario porque **no hay mutation de archive de InventoryItemPredictedUsage en el scan**; setear `microQuantityPerPart=0` los deja inertes (no afectan planeación) aunque sigan listados visualmente.

**3. Bug 3 — `MontoMinimo` se borra siempre del legacy.**

El campo `DatosPlanificacion.MontoMinimo` ya no existe en el esquema de RJSF, pero los PNs legacy lo tienen embebido en `customInputs`. `mergeCustomInputs(existing, part)` ahora hace `delete ci.DatosPlanificacion.montoMinimo` y `delete ci.DatosPlanificacion.MontoMinimo` (ambas capitalizaciones por seguridad) inmediatamente después del JSON deep clone — antes de aplicar overrides del CSV. Cualquier MODIFY sobre legacy lo limpia. No requiere acción del operador.

**4. UX — getter `window.BulkUpload.__state` para snippets diagnósticos.**

`state` es module-level dentro del IIFE y `nextRunId()` lo reasigna, así que un snapshot pegado a `window.BulkUpload` quedaría stale. Solución: getter en la return del IIFE:
```js
return { execute, setProgressCallback, parseCSV, parseRows, __helpers, get __state() { return state; } };
```
Ahora cualquier diagnóstico de consola (ver al final de esta entrada) lee el state vivo.

**5. UX — Texto del progress bar.**

Antes: `setPanelPhase('Verificando PNs existentes (97 búsquedas)')`. Ahora: `(97 búsquedas únicas / 100 registros)`. El operador entiende que el dedup es por `(name|customerId)` y que las 3 filas faltantes son duplicados internos del CSV (no faltantes).

**Bug 2 — diagnóstico (NO es bug del applet; Steelhead UI quote line no filtra `archivedAt`).**

Síntoma reportado: tras MODIFY exitoso de un PN, la UI nativa de Steelhead muestra ambas specs (la archivada vieja y la nueva activa) en la línea de la cotización. Diagnóstico desde `~/Downloads/scan_results_2026-05-21_085044.json`: 5 PNs (`46007-580-01`, `46007-902-01`, `46008-071-01`, `46032-583-01`, `48182-577-01`) muestran shape `partNumberSpecsByPartNumberId.nodes[]` con DOS entries — una con `archivedAt` timestamped (la vieja), otra sin `archivedAt` (la nueva). **El archive sentinel de bulk-upload funciona correctamente** (el `partNumberSpecsToArchive` en `SavePartNumber` SÍ marca el link como archivado).

Donde está el bug: la query `GetQuote` que pobla la línea de la cotización en Steelhead NO filtra `archivedAt` en `partNumberSpecsByPartNumberId.nodes[]`. Esto es bug nativo del UI de Steelhead, no de bulk-upload. La query del PN aislado (`GetPartNumber`) SÍ filtra correctamente — solo el contexto de "spec en línea de cotización" muestra archivados.

**Workaround del operador**: en la quote line, las specs archivadas aparecen tachadas o con marker visual distinto (depende del flujo). Si Steelhead alguna vez expone una mutation de hard-delete (`DeletePartNumberSpec` o similar), se podría considerar; el scan actual no la tiene capturada y no hay forma de borrar el link, solo archivarlo.

**No-fix consciente.** Documentar y mover.

**Files tocados (deploy PENDIENTE):**
- MODIFICADO `remote/scripts/bulk-upload.js`:
  - `VERSION` 1.2.11 → 1.2.12
  - `classifyOnePN` (líneas ~3679-3805): Pases 1/2 sobre `allPns`, Pase 3 sobre `activePns`, `wasArchived` en todos los returns
  - `buildClassifiedRow` (línea ~1006): propaga `wasArchived` al row
  - `classifyPNsOnDemand` (línea ~1124): propaga `wasArchived` al pnStatus
  - `dedupModifyTargets.confRank` (línea ~3850): `stripArch()` para que `'-desarchiva'` no rompa el ranking
  - `mergeCustomInputs` (línea ~697): `delete ci.DatosPlanificacion.{m,M}ontoMinimo`
  - Parse BB raw (línea ~602): sentinel `-` en predictives antes de `gn`
  - STEP 6a (línea ~3144): `predIsDash` → iter `exMap.values()` con `microQuantityPerPart: 0`
  - `setPanelPhase` (línea 909): texto "búsquedas únicas / N registros"
  - return del IIFE (línea 3929): `get __state()`
  - CSS (línea 1064): nueva clase `.dl9-unarch-chip`
  - Render de preview (línea ~1352): chip "🔓 desarch" cuando `r.wasArchived`
- MODIFICADO `remote/config.json` (`version: 1.2.11 → 1.2.12`, `lastUpdated: 2026-05-21`).
- MODIFICADO `tools/test/bulk-upload-helpers.test.js`:
  - Test viejo "archivedAt excluye PNs aunque matcheen" actualizado a "1.2.12 archivedAt YA NO excluye en Pase 1 (opción B)"
  - +5 tests nuevos para opción B (Pase 1 con archivado, Pase 2 con archivado, Pase 1 activo no marca wasArchived, Pase 3 sigue ignorando archivados, Pase 1-IBMS-archivado gana sobre Pase 3-name-activo)
  - Total: 50 tests pasando.

**Plan de validación PENDIENTE (USUARIO):**

*Sanity post-deploy:*
1. Recargar extensión (chrome://extensions → reload) ~30-60s después del push de gh-pages.
2. En la tab de Steelhead, abrir DevTools → Console → `window.BulkUpload?.VERSION` → debe decir `'1.2.12'`.
3. Pegar el siguiente snippet ANTES de cargar el CSV (sólo para confirmar que el getter funciona):
   ```js
   console.log('state vacío esperado:', window.BulkUpload?.__state);
   ```
   Debe devolver un objeto con `runId`, `parts: []`, etc., NO undefined.

*Opción B (auto-unarchive):*
4. Tomar un PN del cliente Schneider que esté actualmente archivado y tenga QuoteIBMS=X (ej. cualquier PN de la corrida previa que disparó el loop).
5. Construir CSV de 1 fila con ese mismo nombre + cliente + QuoteIBMS=X.
6. Subir CSV → preview debe mostrar:
   - Fila clasificada como MODIFY al PN archivado (no NEW).
   - Chip azul "🔓 desarch" junto al PN.
   - Confidence en el dropdown: `ibms-exacto-desarchiva`.
7. Ejecutar → en Steelhead, abrir el PN → debe estar desarchivado con datos del CSV aplicados.

*Sentinel `-` en predictives (Bug 1A):*
8. PN con consumos predictivos existentes (ej. Estaño=0.5 g/pza, Plata=0.2 g/pza).
9. CSV con `-` en BB (columna Plata) → predictive `microQuantityPerPart` de los 2 records debe quedar en 0 tras ejecutar.
10. Verificar en la UI nativa: el bloque "Predicted Inventory Usage" debe mostrar los items con valor 0 (NO archivados pero inertes).

*MontoMinimo strip (Bug 3):*
11. PN legacy con `customInputs.DatosPlanificacion.montoMinimo: 1000` (puedes confirmar con DevTools → `JSON.parse(localStorage.getItem('sa_bulk_resume_<key>')||...)` o leer del XLSX descargado del Pase 3).
12. Cargar CSV que dispare MODIFY sobre ese PN (cualquier cambio mínimo).
13. Tras ejecutar, leer el PN con `GetPartNumber` desde consola: `customInputs.DatosPlanificacion.montoMinimo` no debe existir.

*UX del progress bar:*
14. Cargar CSV de 100 filas con 3 duplicados internos (mismo PN+cliente repetidos).
15. Durante la fase de búsqueda, debe leer "Verificando PNs existentes (97 búsquedas únicas / 100 registros)".

**Snippet diagnóstico actualizado (poscarga del CSV) para que el usuario pueda inspeccionar el state vivo:**
```js
(() => {
  const s = window.BulkUpload?.__state;
  if (!s) { console.log('state no disponible — recarga la extensión, debe ser 1.2.12+'); return; }
  console.log('runId:', s.runId);
  console.log('parts:', s.parts?.length || 0, 'rows');
  console.log('archiveGlobal:', s.archiveGlobal);
  // Primeras 5 filas con flags clave:
  (s.parts || []).slice(0, 5).forEach((p, i) => {
    console.log(`[${i}]`, p.pn, '| customer:', p.customerId, '| quoteIBMS:', p.quoteIBMS, '| archivarAnterior:', p.archivarAnterior, '| archiveOverride:', p.archiveOverride);
  });
  // pnStatus si existe (después de clasificación):
  if (s.pnStatus) {
    console.log('pnStatus:', s.pnStatus.length);
    const wasArch = s.pnStatus.filter(x => x.wasArchived);
    console.log(`PNs desarchivables (Pase 1/2): ${wasArch.length}`);
    wasArch.slice(0, 10).forEach(x => console.log('  →', x.pn, '#'+x.existingId, x.confidence));
  }
})();
```

**Pendientes derivados (no bloqueantes):**
- Cuando Steelhead exponga una mutation de hard-delete de `partNumberSpecs`, evaluar si vale la pena migrar de archive a delete para que Bug 2 (UI nativo de quote line) deje de mostrar specs viejas. Hoy no existe esa mutation en el scan.
- Auditar todos los demás campos `customInputs` legacy que pudieran haber quedado huérfanos del schema actual (similar a `montoMinimo`) y agregar strip-on-MODIFY si aparecen.

## `bulk-upload` 1.2.13: `includeArchived: 'YES'` + diff de IDs para sintetizar `archivedAt` + expone state.parts/pnStatus (2026-05-21, deploy PENDIENTE)
Hotfix sobre 1.2.12 que cierra el último gap de la Opción B: aunque el classifier ya sabía cómo matchear archivados, el applet NUNCA recibía PNs archivados porque el persisted query de `AllPartNumbers` los filtra server-side por defecto. Resultado en la corrida del 2026-05-21: 80 de 100 filas defaultearon a "Crear nuevo PN" aunque para muchas existía un archivado con la misma QuoteIBMS, disparando el loop de auto-archivado que la Opción B intentaba romper.

**Descubrimiento del parámetro.** El UI nativo de Steelhead usa `includeArchived` (enum) cuando el operador activa "Show archived" en el catálogo de PNs. Probando valores en consola (snippet del 2026-05-21):
- `EXCLUSIVELY` → solo archivados (lo que el UI usa para el toggle "sólo archivados")
- `YES` → activos + archivados (es lo que necesitamos)
- `NO` → solo activos (default cuando el parámetro se omite)
- `INCLUSIVELY`, `INCLUDE`, `BOTH`, `ALL`, `NEVER`, `OPTIONAL` → HTTP 400 (no son enum válidos)

**Gap del persisted query: `archivedAt` no viene en el selection set.** Confirmado dumpeando los 5 resultados de `AllPartNumbers(includeArchived: 'YES', searchQuery: '46007-902-01')`: las 28 keys del nodo (nodeId, id, createdAt, creatorId, name, shortName, uuid, isTemplate, inventoryItem..., customInputs, ...) NO incluyen `archivedAt`. La query selecciona los campos que el UI del catálogo de PNs necesita y "Archivado SÍ/NO" no es uno de ellos — el UI lo infiere de otro flag o lo ignora visualmente. Para nosotros eso significa que `extractPNShape` siempre vería `archivedAt: null` aunque el PN realmente estuviera archivado.

**Approach: dos pasadas con diff por ID.** Para cada llamada a `AllPartNumbers` (modo masivo y modo día), hacemos:
1. Pasada NO: `includeArchived: 'NO'` → llenamos el resultado normal Y construimos un `Set<id>` de activos.
2. Pasada YES: `includeArchived: 'YES'` → para cada PN cuyo ID NO esté en el Set de activos, lo agregamos con `shape.archivedAt = ARCHIVED_SENTINEL` (sentinel `'archived'`, no un ISO timestamp).
3. Los callers existentes usan `!p.archivedAt` para distinguir, así que un string truthy basta. La lógica de Pase 1/2 (1.2.12) ya respeta el flag (`byIbms.archivedAt ? '-desarchiva' : ''`).

**Costo.** Duplicamos las queries de `AllPartNumbers`. Modo masivo: ~250 calls → ~500 (dominio ~50k PNs). Modo día: ~|uniq(PN,cliente)| calls → 2×. Aceptable porque (a) ya teníamos paginación de 200/page y retry exponencial, (b) los archivados son pasada secundaria — si el operador no tiene CSV con muchos archivados, el segundo loop trae 0 nodos relevantes y termina rápido.

**Lección clave.** Las persisted queries no son contratos del backend de Steelhead — son selection sets congelados de cómo el UI usa GraphQL hoy. Si un applet necesita un campo que el UI no necesita, no llegará en la respuesta aunque el campo exista en el esquema. Tres opciones cuando esto pasa:
1. **Sintetizar el campo localmente** vía diff de dos queries con filtros distintos (lo que hicimos aquí — barato si los filtros se pueden invertir cleanly).
2. **Llamar `GetPartNumber` por PN** que sí trae el campo (caro: ~|N| queries adicionales — descartado para bulk-upload).
3. **Pinear un nuevo hash** que incluya el campo — requiere que Steelhead ya tenga esa variante registrada (que no hay garantía).

Aplicable a futuros applets que necesiten campos no expuestos por persisted queries del catálogo.

**Bonus 1.2.13: `state.parts`, `state.pnStatus`, `state.archiveGlobal` expuestos en state.** El snippet diagnóstico del 1.2.12 (`window.BulkUpload.__state`) devolvía `parts: 0 rows`, `archiveGlobal: undefined` porque esas eran variables LOCALES de `execute()` no parte del state module-level. Ahora:
- `state.parts` se asigna después de `parseRows(parseCSV(csvClean))` (es la misma referencia que `parts`, así que muta automáticamente cuando los STEPs filtran).
- `state.pnStatus` se asigna después de `checkPNExistence(parts, myRunId)`.
- `state.archiveGlobal` defaulta a `true` en el state inicial y en `nextRunId()` (antes solo se setteaba si el operador interactuaba con el checkbox global).

El snippet diagnóstico del 1.2.12 ahora reporta los valores reales.

**Files tocados (deploy PENDIENTE):**
- MODIFICADO `remote/scripts/bulk-upload.js`:
  - `VERSION` 1.2.12 → 1.2.13
  - Nueva constante `ARCHIVED_SENTINEL = 'archived'` (línea ~52)
  - `state` inicial + `nextRunId()`: agregan `parts: []`, `pnStatus: []`, `archiveGlobal: true`
  - `prefetchPNsByCustomer` (línea ~755): dos pasadas NO + YES con diff
  - `classifyPNsOnDemand` (línea ~910): dos pasadas NO + YES por uniq con diff
  - `execute()`: `state.parts = parts` después del parse; `state.pnStatus = pnStatus` después de `checkPNExistence`
- MODIFICADO `remote/config.json`: bump 1.2.12 → 1.2.13.
- MODIFICADO `tools/test/bulk-upload-helpers.test.js`: SIN cambios (50/50 siguen pasando porque la lógica del classifier no cambió — solo de dónde le llegan los datos).

**Estado de deploy:** PENDIENTE de autorización del usuario.

**Plan de validación PENDIENTE (USUARIO, tras deploy):**

*Sanity post-deploy:*
1. Recargar extensión (chrome://extensions → reload) ~30-60s después del push de gh-pages.
2. En la tab de Steelhead, abrir DevTools → Console → `window.BulkUpload?.VERSION` → debe decir `'1.2.13'`.
3. Validar que `__state` está vacío esperablemente: `console.log(window.BulkUpload.__state)` antes de cargar CSV → debe traer `runId`, `parts: []`, `pnStatus: []`, `archiveGlobal: true`.

*Caso clave (PN duplicado de Schneider con archivado):*
4. Subir el mismo CSV que disparó las "80 decisiones pendientes" en 1.2.12.
5. Para el PN `46007-902-01` (5 instancias: 4 activos + 1 archivado #3016647 con IBMS=35219): si la fila CSV tiene IBMS=35219, debe matchear el archivado vía Pase 1 con confidence `ibms-exacto-desarchiva` y mostrar chip "🔓 desarch" en el preview.
6. Para PNs cuyo CSV IBMS NO matchea ningún activo ni archivado, debe caer a Pase 3 normal (sin contaminar el dropdown con archivados — Pase 3 sigue limitado a activos).
7. La estadística "decisiones pendientes" debe bajar significativamente vs 1.2.12 (idealmente <20 de 100).

*Snippet diagnóstico (debería funcionar ahora):*
```js
(() => {
  const s = window.BulkUpload?.__state;
  if (!s) { console.log('state no disponible'); return; }
  console.log('runId:', s.runId);
  console.log('parts:', s.parts?.length || 0, 'rows');
  console.log('archiveGlobal:', s.archiveGlobal);
  console.log('pnStatus:', s.pnStatus?.length || 0);
  const wasArch = (s.pnStatus || []).filter(x => x.wasArchived);
  console.log(`PNs desarchivables (Pase 1/2): ${wasArch.length}`);
  wasArch.slice(0, 10).forEach(x => console.log('  →', x.pn, '#'+x.existingId, x.confidence));
})();
```

*Performance check:*
8. Verificar en Network tab que aparecen DOS bloques de queries `AllPartNumbers` por uniq (NO seguido de YES). Si el segundo bloque es muy rápido (0 resultados por PN porque el cliente no tiene archivados), confirma que la duplicación de costo es real pero acotada.

**Pendientes derivados (no bloqueantes):**
- Considerar caché de archivados por dominio: si el operador corre múltiples CSVs en una sesión, podríamos cachear el resultado de la pasada YES por (customerId, runId) y solo refrescar cada N minutos. Aplicable solo si el deploy actual resulta lento.
- Investigar si el hash de `AllPartNumbers` que usa el UI cuando se activa el toggle "Show archived" trae un selection set distinto con `archivedAt`. Si existe, podríamos pinear ese hash y eliminar la segunda pasada. Re-scan con el toggle activado lo confirmaría.

## `bulk-upload` 1.3.0: Quote Chunking — partir cotizaciones grandes COTIZACIÓN+NP en lotes de N líneas (2026-05-21, deploy PENDIENTE)
Motivación: la cotización de Schneider Electric México con 5,000+ líneas tarda ~6 minutos en abrir en Steelhead (regla empírica observada: `t ≈ 1 + 0.07n` segundos para N líneas — 100 líneas ≈ 8s; 5000 ≈ 6min). El usuario aclaró que para Schneider la cotización se usa como **diccionario de facturación** (PN → productos/lote para el facturador), NO como fuente de órdenes de venta, así que partirla en varias cotizaciones más pequeñas no cambia el flujo operativo. Para otros clientes la cotización SÍ dispara OV; el chunk loop respeta a ambos porque solo agrega un sufijo cuando `chunks.length > 1`.

**Decisiones de diseño cerradas con el usuario antes de implementar:**

1. **Default 250 líneas por chunk, editable en el preview** (input number `min=10 step=10`). Solo visible en COTIZACIÓN+NP (no aplica a SOLO_PN).
2. **Sufijo del nombre:** si todo cabe en 1 chunk → nombre original sin sufijo. >1 chunks → `<name> 01`, `<name> 02`, etc. (espacio + 2 dígitos zero-padded vía `padStart(2,'0')`, que escala gracefully a 3+ dígitos si pasamos 99). Cita exacta del usuario: *"quítale el &, era sólo concatenar, déjalo en espacio y número forzado a dos dígitos: 01, 02, 03, etc."*
3. **Chunks contiguos puros** — slicing simple por orden de `custParts`. No agrupa duplicados entre chunks. El usuario: *"OK continuos puros, da lo mismo."* Los duplicados internos del CSV ya se ven informativamente vía el chip "🔄 DUP n/m" en el preview (1.2.11 H1) y el classifier los decide por separado fila por fila.
4. **Resume vs restart fresco** — comportamiento dual:
   - **Resume** (CSV idéntico → `runKey` hash matches): salta chunks ya completados en `resumeState.completedChunks[cid]`. El `chunkSize` queda lockeado de la corrida original (no se respeta cambio en el preview si haces resume).
   - **Restart fresco** (decidió "Empezar de cero" en el modal de resume): cada chunk vuelve a disparar `findExistingQuote` + modal modify/skip/create estándar, igual que si fuera la primera corrida.
   Cita del usuario: *"si es resume sí, si es empezar de nuevo se modifican."*

**Arquitectura:**

```
Estructura de execute() COTIZACIÓN+NP, after STEP 2 (SaveManyPNP):

  partsByCustomer = Map<cid, [{part, status, origIdx}, ...]>

  // Pre-cómputo: chunks por cliente + total global para barras de progreso.
  chunkSize = resumeState.chunkSize || state.chunkSize || bulkCfg().chunking.defaultChunkSize
  chunksByCust = Map<cid, [chunkSlice[], ...]>
  totalChunks = sum(chunks.length por cliente)

  for (const [cid, custParts] of partsByCustomer):
    for (cIdx = 0; cIdx < chunks.length; cIdx++):
      if (resumeState.completedChunks[cid].includes(cIdx)) continue
      chunkSlice = chunks[cIdx]
      thisQuoteName = makeChunkQuoteName(quoteName, cIdx, chunks.length)
      [pipeline existente: findExistingQuote → modal → CreateQuote/Modify →
       SaveManyPNP (sobre chunkSlice) → GetQuote → pnLookup → SaveQuoteLines
       (sobre chunkSlice) → UpdateQuote notes]
      // Persistir chunk completado:
      resumeState.completedChunks[cid].push(cIdx)
      await persistResumeState()
```

**Helpers nuevos en bulk-upload.js (line ~4060, expuestos en `__helpers`):**

```js
function chunkParts(arr, chunkSize) {
  if (!Array.isArray(arr) || arr.length === 0) return [];
  const size = Math.max(1, Math.floor(Number(chunkSize) || 1));
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}
function makeChunkQuoteName(originalName, chunkIndex, totalChunks) {
  if (totalChunks <= 1) return originalName;
  return `${originalName} ${String(chunkIndex + 1).padStart(2, '0')}`;
}
```

**State + resume schema extendidos:**

- `state.chunkSize: number | null` — se setea en el handler EJECUTAR del preview leyendo `#dl9-chunksize`. `null` en isSoloPN.
- `resumeState.chunkSize: number | null` — lockeado al iniciar `resumeState` por primera vez; hidratado al hacer resume desde corrida pre-1.3.0 (`if !chunkSize → state.chunkSize || default`).
- `resumeState.completedChunks: { [cid: string]: number[] }` — mapa cid (string del customerId) → array de chunk indices completados. Se persiste vía `persistResumeState()` después de cada chunk exitoso (UpdateQuote notes ok).

**Preview UI:**

En showPreview, si `!isSoloPN`, se inyecta un campo nuevo en la fila de filtros junto al toggle archive:

```html
<label>Chunk:
  <input type="number" id="dl9-chunksize" min="10" step="10" value="${defaultChunkSize}">
  <span id="dl9-chunkpreview">→ N cliente(s), M cotización(es)</span>
</label>
```

El span de preview se recalcula on `input` event y on cualquier cambio de selección (vía hook `onSelChange` agregado a `updateSelCount()` para no romper strict mode con monkey-patching). Computa `ceil(parts[cliente].length / size)` sumado para los clientes con al menos 1 fila seleccionada.

**Lecciones del ciclo:**

- **Strict mode prohíbe reasignar function declarations.** El primer intento del live-preview hizo `updateSelCount = function() { ... }` para wrappear la función con un trigger de recálculo. Fallo silencioso en producción (assignment to function declaration es TypeError en strict mode). Refactor a callback hook: `let onSelChange = null;` en el scope superior, `updateSelCount()` lo llama si está seteado, y el bloque de chunking lo asigna a `recalcChunkPreview`. Patrón aplicable a cualquier widget que necesite reaccionar a state interno de otro widget sin tocar su declaración.

- **Node test sandbox `assert.deepEqual([], [])` falla cross-context.** Cuando los helpers se exportan vía `__helpers` y el test los carga con `vm.runInThisContext`, los arrays retornados por el sandbox tienen un constructor `Array` distinto al del módulo de test. `assert.deepEqual(H.chunkParts([], 250), [])` arroja `Values have same structure but are not reference-equal`. Workaround: `assert.equal(r.length, 0)` o `assert.deepStrictEqual` con valores primitivos. Aplica a cualquier test futuro que invoke helpers via vm sandbox.

- **resumeState como single-source-of-truth para "lockear" parámetros del flujo.** El user puede editar el chunkSize en el preview entre corridas, pero un resume debe respetar el tamaño de la corrida original (cambiarlo a mitad de corrida partiría chunks distintos y crearía cotizaciones duplicadas). Patrón general: cualquier parámetro que afecte particionamiento del trabajo se persiste en `resumeState` al iniciarla y se lee de ahí en lugar de `state` cuando hay resume. Aplica a futuros applets con persistencia (chunk size, batch size, paginación, etc.).

- **Pre-cómputo de totales antes del loop.** El `quoteSeq / partsByCustomer.size` original sub-reporta el progreso cuando hay chunks (`totalChunks > partsByCustomer.size`). El fix: `totalChunks = sum(chunks.length)` calculado UNA vez antes del loop, usado en todos los `setProgressBar` y `showProgressUI`. Patrón aplicable a cualquier loop anidado donde la barra de progreso debe reflejar el total real de operaciones, no la cardinalidad del outer.

**Files tocados (deploy PENDIENTE):**

- MODIFICADO `remote/scripts/bulk-upload.js`:
  - `VERSION` 1.2.13 → 1.3.0
  - `state` inicial + `nextRunId()`: agregan `chunkSize: null`
  - `bulkCfg()` accessor: agrega `chunking.defaultChunkSize` con default 250
  - `showPreview()`: input `#dl9-chunksize` + span `#dl9-chunkpreview` (solo `!isSoloPN`), callback `onSelChange`, captura del valor en handler EJECUTAR
  - `execute()` COTIZACIÓN+NP: pre-cómputo `chunksByCust` + `totalChunks`, loop interno `for (cIdx = 0; cIdx < chunks.length; cIdx++)` con skip por resume + bailIfStale + persist al final, `custParts` → `chunkSlice` en SaveManyPNP + SaveQuoteLines
  - Resume schema inicial: `chunkSize` + `completedChunks: {}`; hidratación para resume pre-1.3.0
  - Helpers nuevos `chunkParts` + `makeChunkQuoteName` expuestos en `__helpers`
- MODIFICADO `remote/config.json`: bump 1.2.13 → 1.3.0, nueva sección `steelhead.domain.bulkUpload.chunking.defaultChunkSize: 250`.
- MODIFICADO `tools/test/bulk-upload-helpers.test.js`: +8 tests (5 para `chunkParts` cobertura edge cases + 3 para `makeChunkQuoteName` incluyendo el caso 3 dígitos). Total: 58 tests pasando.

**Plan de validación PENDIENTE (USUARIO, tras deploy):**

*Sanity post-deploy:*
1. Recargar extensión (chrome://extensions → reload) ~30-60s después del push de gh-pages.
2. En la tab de Steelhead, DevTools → Console → `window.BulkUpload?.VERSION` → debe decir `'1.3.0'`.

*Caso "una cotización" (sin sufijo):*
3. CSV de 50 filas COTIZACIÓN+NP, un solo cliente. Preview: chunk input default `250`, preview span dice `→ 1 cliente(s), 1 cotización(es)`. Ejecutar → en Steelhead aparece UNA cotización con el `quoteName` original (sin " 01").

*Caso "tres chunks" (con sufijo):*
4. CSV de 600 filas COTIZACIÓN+NP, un solo cliente. Preview: chunk input default `250`, preview span dice `→ 1 cliente(s), 3 cotización(es)`. Ejecutar → en Steelhead aparecen 3 cotizaciones nombradas `<quoteName> 01`, `<quoteName> 02`, `<quoteName> 03` con 250/250/100 líneas respectivamente.

*Caso "edición del chunk size en preview":*
5. Mismo CSV de 600 filas. En el preview, cambiar el chunk input a `300`. El preview span debe actualizar a `→ 1 cliente(s), 2 cotización(es)` instantáneamente. Ejecutar → 2 cotizaciones `<name> 01` (300) y `<name> 02` (300).

*Caso "multi-cliente con chunks dispares":*
6. CSV con 2 clientes: Cliente A con 100 filas (cabe en 1 chunk), Cliente B con 500 filas (necesita 2 chunks). Preview span debe decir `→ 2 cliente(s), 3 cotización(es)`. Ejecutar → 1 cotización para A sin sufijo, 2 cotizaciones para B con " 01" y " 02".

*Caso "resume tras crash":*
7. CSV de 800 filas COTIZACIÓN+NP, un solo cliente. Iniciar (genera 4 cotizaciones esperadas). Cerrar tab a media corrida (cuando ya completaron 1-2 chunks según el log). Reabrir Steelhead, recargar extensión, relanzar el MISMO CSV. Modal de resume debe aparecer → elegir "Reanudar". Verificar en el log: `${cust.name} chunk 1/4: ya completado, saltando` (y/o 2/4). Las cotizaciones ya completas NO se re-tocan; solo continúa con las pendientes.

*Caso "restart fresco":*
8. Mismo CSV de 800 filas, con corrida previa parcialmente completa en localStorage. Lanzar → modal de resume → elegir "Empezar de cero". Las 4 cotizaciones deben dispararse desde el inicio. Por cada chunk que ya existe en Steelhead (de la corrida abortada), el modal modify/skip/create debe aparecer. Decidir "modify" para todos → las cotizaciones existentes se sobrescriben con datos frescos del CSV.

*Sanity Schneider real:*
9. CSV de Schneider Electric MX activos 2025 (5,000+ filas, 1 cliente). Default 250 → 20 cotizaciones. Verificar que el run completo termina sin que ninguna cotización se atore esperando a Steelhead abrir (el bug original). El log debe mostrar avance de `Quote 1/20 → 2/20 → ... → 20/20`.

**Pendientes derivados (no bloqueantes):**

- **Manejo de fail-fast por chunk.** Hoy si un chunk falla (CreateQuote 502 que excede los retries, p.ej.), se loguea el error y el chunk NO se marca completado (resume lo intentará después). El siguiente chunk del mismo cliente igualmente continúa. Si el operador prefiere "abortar todo el cliente al primer fallo", habría que agregar un flag `state.abortClienteAlFallar` o similar — no incluido en MVP.
- **Chunks paralelos por cliente.** Hoy es secuencial dentro del loop por cliente. Steelhead probablemente tolera 2-3 cotizaciones nuevas en paralelo (cada `CreateQuote` + `SaveManyPNP` + `SaveQuoteLines` es atómico). Si el throughput resulta insuficiente para CSVs muy grandes (>10k filas), considerar `runPool(chunks, ..., 2)` para chunks de un mismo cliente. No incluido en MVP por simplicidad — la corrida secuencial es razonable.
- **Resume con chunks que cambian de definición.** Hoy un resume requiere que el CSV sea byte-idéntico (runKey hash). Si el operador edita el CSV (reordena filas, agrega 1 fila), el runKey cambia y todo se reclasifica. Eso es correcto pero hay un edge case: si el CSV es exactamente el mismo pero el operador cambió el chunkSize en el preview a mitad de un resume — el `resumeState.chunkSize` original gana y el preview value se ignora. La UI no comunica esto; podríamos mostrar un aviso "Resume usa chunkSize=N (de corrida original)" al detectar el caso. No-bloqueante.

## VBA Module2 v11: macro Refrescar Listas con catálogos desde libro externo (2026-05-21, sin deploy — vive en el .xlsm)
Archivo nuevo `VBA_Module2_v11.txt` que reemplaza la macro `RefrescarListas` del legacy v84 (que leía catálogos desde hojas internas hardcoded). El v11 ahora lee desde el libro externo `Plantilla_Cotizaciones_y_NP_v84_1_catalogos.xlsx` (Productos, Clientes, Acabados, Procesos, RackTypes, Métricas, etc.) y popula los rangos nombrados de la plantilla activa con datos frescos. El usuario instala manualmente igual que Module1 v11 (Alt+F11 → Module2 → reemplazar todo el contenido). Sin deploy a `remote/` ni a `gh-pages` porque el .xlsm no se distribuye desde GitHub Pages.

## VBA Module1 v11: hardening del exportador de CSV (2026-05-19, sin deploy — vive en el .xlsm)
Refactor de la macro `ExportarCSV()` de `Plantilla_Cotizaciones_y_NP_v84_1.xlsm` para producir CSVs deterministas que sobrevivan el flujo de resume tras crash de `bulk-upload` 1.0.0. Archivo nuevo `VBA_Module1_v11.txt` en la raíz del proyecto (los `VBA_*v10.txt` y `VBA_*v84.txt` viejos fueron eliminados en este ciclo; quedaron solo los 5 archivos v10 activos + el v11 nuevo).

**5 cambios al v10:**

1. **Validación de Modo (G1) + QuoteName (G3)**. Bloquea export si G1 no es `COTIZACIÓN+NP`/`SOLO_PN`, o si COTIZACIÓN+NP no trae quoteName en G3. Normalización Ó→O para tolerar Excel-Mac (que pierde acentos en algunos casos) vs Excel-Win.
2. **Cliente único en COTIZACIÓN+NP.** Si la plantilla mezcla varios clientes por error, aborta. Una cotización vive bajo un solo customer; mezclar rompe el flujo del modal `modify`. Hasta 6 clientes listados en el mensaje de error para diagnóstico rápido.
3. **Orden determinístico (Cliente, PN) en libro temporal antes del SaveAs.** Sin esto, dos exports del mismo dataset producen byte-strings distintos si el usuario re-ordena entre crashes, y el `runKey = sha256(csv)` se invalida. El sort vive en `tmpWs` (no en `ws`) para no tocar el orden visual de la hoja Upload del usuario.
4. **Sugerencia inteligente de nombre de archivo** según modo + fecha (`solopn-yyyymmdd-hhnn` o `<quoteName>-yyyymmdd`). El timestamp en el nombre **NO afecta runKey** (que se calcula sobre el contenido del CSV, no el filename). Solo ayuda al usuario a distinguir archivos en Descargas.
5. **Aviso si SOLO_PN > 2,000 filas.** Recomienda chunkear antes de exportar. El usuario puede confirmar continuar — pero se le advierte que el run será largo y dificulta el resume.

**Lección clave del ciclo VBA:**
- **Determinismo del CSV es responsabilidad del exportador, no del applet.** El applet calcula `sha256(csvText)` sin manipular nada. Si el VBA emite filas en orden distinto entre exports, el runKey cambia y el resume no aplica. Mover el sort a VBA (no al applet) tiene dos ventajas: (1) byte-exact garantizado en la fuente, (2) el applet no necesita complicar su parser. Aplica a cualquier futura integración Excel↔extensión donde haya state persistente keyed por hash del input.
- **`SaveAs FileFormat:=62` (CSV UTF-8) ya emite CRLF estable en ambos OS.** No requiere conversión manual de line endings. Único caveat: Excel-Win agrega BOM `EF BB BF` al inicio, Excel-Mac a veces no. Esto puede dar runKeys distintos entre máquinas, pero si el usuario siempre exporta desde la misma máquina, es consistente. No-bloqueante para MVP.
- **Limpieza de versiones viejas en el repo.** Antes del ciclo había 7 archivos VBA en root: 5 v10 (vigentes) + `VBA_Module1_v84.txt` (61 cols, layout name en C4 — superseded) + `VBA_Module2_RefrescarListas.txt` (lee catálogos desde hojas internas en vez del archivo externo — superseded). Eliminados con `rm`. Ahora son 5 v10 + 1 v11 (Module1) = 6 archivos activos.

**Files tocados (sin deploy, solo en `main`):**
- NUEVO `VBA_Module1_v11.txt` (~175 líneas) — reemplazo de `VBA_Module1_v10.txt` en la macro Module1 del .xlsm.
- ELIMINADOS `VBA_Module1_v84.txt`, `VBA_Module2_RefrescarListas.txt`.
- SIN cambios en el .xlsm todavía (el usuario debe abrir Plantilla, Alt+F11, borrar contenido de Module1 y pegar el v11).

**Pendientes derivados (no bloqueantes para corrida):**
- El usuario debe instalar manualmente el v11 en el .xlsm antes de exportar los 4 CSVs (paso documentado en el chat de la sesión).
- Después de la corrida completa exitosa, considerar promover el v11 a `VBA_Module1_v10.txt` (renombrar) para que sea la versión "vigente" sin confusión de números — o cambiar la convención de naming a sin sufijo de versión + git tags.
- Tests automatizados del parser CSV del applet (item ya en pendientes del audit pre-producción).
- Eliminar duplicación de la lógica de "limpiar caracteres inválidos" entre `csvName` y `baseName` en VBA — quedó ligeramente redundante pero funcional.

