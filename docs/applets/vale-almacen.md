# Bitácora: `vale-almacen` (Vale de Almacén)

**Versión actual:** 0.1.2 (fix: la emisión de un vale = **solo la solicitud** → llena los sensores del paso 0, lo completa (ya NO lo archiva) y **deja el evento VIVO** —sin `completedAt`—. Almacén surte/confirma después, fuera del applet; el evento solo se cierra al DESCARTAR. Ver §"Lección: `archivedAt` deshace, no completa" y §"El vale = solo la solicitud"). 0.1.0 = código completo + golden tests.
**Archivos:** `remote/scripts/vale-almacen.js` (FAB + panel + API), `remote/scripts/vale-almacen-engine.js` (motor puro), `tools/test/vale-almacen-engine.test.js` (19 tests).
**Config:** app `vale-almacen` en `apps[]`; hashes nuevos `GetMaintenanceEvent`, `UpdateMaintenanceNodeEvent`, `UserDialogQuery`; bump `1.7.20`.

## Qué hace
Botón flotante 📦 (dark mode) sobre pantallas de Producción / Mantenimiento / Tableros de sensores / Inventario que emite un **vale de almacén** = evento de mantenimiento sobre un nodo de tipo "Surtimiento". Captura múltiples líneas `(artículo + cantidad + usuario asignado)`, registra la persona que recoge el vale en el campo "Asignado" del evento, y deja cada asignación como **comentario estructurado y parseable** para reconstruir después la BD de entregas por usuario (detectar abusos, p. ej. cuánto EPP se le entregó a alguien).

Es un primo de `paros-linea` (mismo molde de FAB/modal/MaintenanceEvent), con tres diferencias: (1) panel multi-línea, (2) los sensores del paso 0 son **artículos con cantidad** (`measurement` numérico) y no motivos PASS/FAIL, (3) número de empleado por usuario.

## Modelo de datos descubierto (Fase 0 — validado contra 2 scans del hash-scanner del 2026-06-30)

### Nodo "Surtimiento" = raíz con 3 pasos hijo
- `CreateMaintenanceEventDialogQuery({})` → `allMaintenanceNodes.nodes[]` devuelve **solo los nodos raíz pickables** (39 con "surtimiento" en el dominio 344; los pasos hijo NO aparecen aquí). Cada raíz: `{id, idInDomain, name}`, `skipExecution:true`. Nombre con prefijo de código de área (`SMP`, `EPP`, `SGL`, `MTY`, `MLA`, `LIM`, `EQT`, `FUN`, `SPR`…). Filtro: `SURT_RE=/surtimiento/i` + `ROOT_CODE_RE=/^[A-Z]{2,4}\s/` (39/39 raíces, 0 falsos positivos).
- La estructura raíz→hijos vive en `GetMaintenanceEvent({idInDomain}).maintenanceEventByIdInDomain.maintenanceNodeByMaintenanceNodeId.descendantRelationships[]` (**array plano**, no `.nodes`). Cada rel: `{childIndex, maintenanceNodeByFromId:{id,idInDomain,name}, maintenanceNodeByToId:{id,name}}`. Ejemplo raíz 20521 "SMP T205-LI…": hijos por `childIndex` → 0 "Solicitud de Laboratorio" (20522), 1 "Surtimiento de Materia Prima" (20523), 2 "Confirmación de Entrega" (20524).

### El paso 0 = catálogo de artículos (sensores NUMBER)
- `OperatorMaintenanceNodeDialogQuery({nodeId, maintenanceEventId})` → `maintenanceNodeById.maintenanceNodeSensorsByMaintenanceNodeId.nodes[].sensorBySensorId.{id, name, sensorTypeBySensorTypeId.{sensorMeasurementType, unitByUnitId.{name, mustBeInteger}}}`.
- Node 20522 tiene **38 sensores, todos `NUMBER`**, unidad "KGM Kilogramo"/"LTS…" (`mustBeInteger:false`). Cada sensor = un artículo; su `name` es el artículo (ej. "T205-MP00 Req. de Estannato de Potasio"). La unidad corta sale del primer token del `unitByUnitId.name`.
- `discoverArticleStep`: resuelve la raíz → primer hijo con sensores NUMBER (normalmente `childIndex 0`), cachea `rootId→step0Id` en `localStorage[sa_vale_step0_map_v1]`. `maintenanceEventId:0` permite leer sensores sin evento (pero igual se pasa el id del evento real).

### Captura de cantidad
- `CreateManySensorMeasurements({input:[{sensorId, measurement:<num>, maintenanceNodeEventId}]})`. Para `NUMBER` el campo es **`measurement`** (NO `measurementNumber`/`measurementFloat`). Booleano→`measurementBoolean`, texto→`measurementText`. Todas las líneas del vale se **batchean** en una sola llamada contra un único nodeEvent. La depleción de inventario la hace SH internamente (responde `specValuePartsTransferAccounts`); NO se manda `inventoryItemId`.

### Número de empleado
- `SearchUsers({searchQuery, first})` → solo `{id, name}` (sin customInputs). Por eso se hace una query por userId:
- `UserDialogQuery({domainId, userId})` → **`userById.customInputs.DatosLaborales.CodigoEmpleado`** (string, patrón `^[A-Z]{3}\d{4}$`, ej. `ABC1234`; `inputSchemaId:96`). Si viene `null` → el comentario emite `emp:?` (no bloquea). Cache en memoria por userId.

### Flujo completo (submitVale)
`CreateMaintenanceEvent(raíz, equipmentId, assigneeId=recoge)` → `GetMaintenanceEvent` → `discoverArticleStep` → operador arma líneas → `CreateMaintenanceNodeEvent(paso0)` → `CreateManySensorMeasurements(batch)` → `[VALE-INI]` + un `[VALE]…` por línea + comentario general → `/api/files`+`CreateUserFile`+`CreateMaintenanceEventUserFile` (evidencia) → `[VALE-FIN]`. **El paso de solicitud NO se archiva** (queda completado por su nodeEvent + mediciones) y **el evento NO se completa** (queda vivo).

### El vale = solo la solicitud (v0.1.2)
La emisión de un vale es **únicamente la solicitud**. El applet debe: (1) llenar los sensores del paso 0 con las cantidades, (2) **completar el paso 0** (no archivarlo), y (3) **dejar el evento VIVO** (sin `completedAt`, sin archivar). Los pasos siguientes —Surtimiento de Materia Prima (paso 1, rebaje real de inventario vía `CreateInventoryTransferEventGroups`) y Confirmación de Entrega (paso 2)— los hace almacén después, **fuera del applet** (por lo pronto). El evento solo se cierra cuando el operador **DESCARTA** el vale (`discardVale` → `UpdateMaintenanceEvent{completedAt}` + comentario `[VALE-DESCARTADO]`).

### Lección: `archivedAt` deshace, no completa (fix 2026-06-30, v0.1.1/0.1.2)
Síntoma: el vale dejaba el primer paso ("Solicitud") **sin completar** y la cantidad no persistía en el sensor; además **completaba el evento** cuando debía quedar vivo. Causa: `submitVale` cerraba el paso con `UpdateMaintenanceNodeEvent{id:nodeEventId, archivedAt}` (bajo la suposición errónea —también en la descripción vieja de `config.json`— de que `archivedAt` marca el paso como completado) y luego hacía `UpdateMaintenanceEvent{completedAt}`.
Evidencia (2 scans del hash-scanner del 2026-06-30, un vale hecho a mano en la UI nativa, evento 156035):
- El flujo feliz por cada paso es `CreateMaintenanceNodeEvent(nodeId,eventId)` → mediciones/transfer → `GetMaintenanceEvent`+`GetNextMaintenanceNodes` (navegación read-only), y al final `UpdateMaintenanceEvent{completedAt}`. **Un paso queda ejecutado/completado por la sola existencia de su `MaintenanceNodeEvent` + sus mediciones.**
- `UpdateMaintenanceNodeEvent` **siempre** fue `{id, archivedAt}` (nunca `completedAt`) y **siempre** precedido de `DeleteSensorMeasurement` → es la operación de **DESHACER/borrar** un paso ejecutado, no de completarlo. Al archivar el paso 0, el applet borraba el paso que acababa de ejecutar y con él sus cantidades.
- Fix (v0.1.1): eliminar la llamada de archivado del paso 0 → el paso se completa solo. `GetNextMaintenanceNodes` es query pura (dado `idInDomains` de nodos devuelve los siguientes); NO se usa en el applet.
- Fix (v0.1.2): eliminar también `UpdateMaintenanceEvent{completedAt}` de la emisión → el evento queda **vivo**. El footer `[VALE-FIN]` cambió de `completedAt:` a `emitido:` (engine `buildFooterComment({items, emitidoAt})`; golden test actualizado). El descarte (`discardVale`) sí completa el evento.
- La depleción de inventario real (paso 1 "Surtimiento de Materia Prima") la dispara la UI nativa con `CreateInventoryTransferEventGroups`, NO automáticamente por las mediciones del paso 0 — pendiente para Fase 2 (ver abajo).

## Formato del comentario estructurado (motor `vale-almacen-engine.js`)
```
[VALE] art:"<artículo>" cant:<num> unidad:"<u>" user:"<usuario>" emp:<CodigoEmpleado|?> linea:"<equipo>" [/VALE]
[VALE-INI] fecha:<ISO> equipo:"…" nodo:"…" recoge:"…" items:N [/VALE-INI]
[VALE-FIN] items:N completedAt:<ISO> [/VALE-FIN]
```
Valores string entre comillas con escape `\"`/`\\`. Parser: `SteelheadValeEngine.parseAllLines(texto)` extrae todos los `[VALE]…[/VALE]`. `emp:?` ↔ `employeeNumber:null`. El comentario general libre va sin sentinel. Round-trip cubierto por tests.

## Arquitectura / reuso
- **Molde:** `paros-linea.js` (FAB con parche `history.pushState`/`popstate`, modal dark, `attachEvidence`, cache de equipos por etiqueta Línea/Célula con TTL 4 h).
- **No toca `extension/`:** la app NO está en el mapa de globals de `background.js`; el handler genérico (`message`+`fn:"ValeAlmacen.open"`) inyecta los scripts y llama `open()`. `open()` es **autocontenido** (`ensureCurrentUser` cacheado en `window.__saValeUser` + `loadCatalogs` perezoso) para sobrevivir la re-inyección que recrea el cierre (convención de los applets nuevos auto-router/archiver).
- **Sin cronómetro** → sin timers que fugar. Estilo dark mode propio prefijo `va-` (base `#1c2430`, acento verde `#13a36f`), FAB en `left:110px` para coexistir con el de Paro de Línea.
- **Resume/descartar:** el vale se crea al "Cargar artículos" y se persiste en `localStorage[sa_vale_active_event]` (incluye las líneas en construcción). El FAB ofrece reabrir; "Descartar" cierra el evento con `[VALE-DESCARTADO]` + `completedAt`.

## Inferencia de línea/equipo
Prioridad: (1) línea inferible del nombre del nodo raíz (`T\d{2,3}` → match contra equipos → dropdown **bloqueado** 🔒); (2) contexto del tablero (`WorkboardById`/headings/`localStorage`, prellenado editable); (3) selección manual. El equipo es **obligatorio** (botón "Cargar artículos" deshabilitado sin equipo + nodo + quien recoge).

## Plan de validación en vivo (pendiente — run real)
1. Deploy: toca `config.json` (app + hashes) → **`deploy.sh` desde `main`** (NO `wb-deploy.sh`), coordinando que no haya WIP ajeno en `remote/` de main. `tools/deploy-status.sh` antes/después.
2. FAB 📦 aparece en `/Domains/344/Workboards/*`, `…/WorkOrders/*` y (confirmar segmentos exactos) Mantenimiento / Tableros de sensores / Inventario; ajustar `ALLOWED_PATH_RE` si difieren.
3. Panel: dropdown lista las raíces de surtimiento; al elegir una con línea inferible el equipo queda bloqueado; sin equipo+nodo+recoge, "Cargar artículos" deshabilitado.
4. "Cargar artículos": el typeahead lista los ~38 artículos del paso 0 con su unidad; filtra al escribir; typeahead de usuario resuelve CodigoEmpleado (mostrar en la columna Núm. emp.).
5. Emitir vale con 2-3 líneas + comentario general + 1 foto → en SH el evento `…/MaintenanceEvents/<idInDomain>` tiene `completedAt`, las cantidades en el paso, los `[VALE]…[/VALE]` (verificar con `parseAllLines`), el comentario general, "Asignado"=quien recoge, y la foto.
6. `ValeAlmacen._state()` en window para depurar (`surtimientoNodes`, `articleCatalog`, `activeEvent`, `lines`).

## Safari/iPad (bundle)
Incluido en el bundle Safari/iPad (`safari/bundle.json`) desde **v0.3.0**. Es "directo": el **FAB 📦 se auto-inyecta** en las pantallas permitidas, así que no necesita popup para el flujo normal. Además hay un **lanzador en el popup** ("Emitir Vale de Almacén"). Canal de lanzamiento (fix de la sesión 2026-07-01): `popup → tabs.sendMessage(tabId,{__saCmd}) → bridge.js runtime.onMessage → postMessage → sa-dispatcher.js → ValeAlmacen.open` (allowlist `LAUNCH_FN`). **Ojo:** `storage.onChanged` NO dispara en el content script de iPadOS, así que el canal viejo (storage-only) no funcionaba; ahora es `tabs.sendMessage` con storage de fallback. Compatible con iOS: sin `a.download`/`chrome.*`/IndexedDB; la evidencia usa `<input type=file>` (cámara del iPad) con gesto de usuario. Los hashes viven en gh-pages (el bridge los refresca en runtime), así que el bundle no se re-hornea al rotar hashes.

## Pendientes / mejoras futuras
- Fase 2: ejecutar también el paso "Confirmación de Entrega" (sensores boolean/text) para marcar entregado.
- Validar cantidad entera cuando `mustBeInteger` (hoy solo `>0`).
- Parser/reporte externo que consuma `parseAllLines` y arme la BD de entregas por usuario (objetivo del comentario estructurado).
- Confirmar segmentos de URL reales de Mantenimiento/Sensores/Inventario.
