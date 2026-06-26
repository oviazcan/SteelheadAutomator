# file-uploader — Cargador de Archivos

**Versión actual:** 0.2.0 (carga masiva inteligente — pendiente deploy + run real)
**Scripts:** `remote/scripts/steelhead-api.js`, `remote/scripts/file-uploader-core.js`, `remote/scripts/file-uploader.js`
**Tests:** `tools/test/file-uploader-core.test.js` (18 golden, núcleo puro)
**Handler:** `extension/background.js` → `upload-pn-files` (input `multiple`, no `webkitdirectory`)

## Qué es
Sube fotos/planos y los vincula a Part Numbers, matcheando por el **nombre del archivo**.
Flujo por archivo: `POST /api/files` (binario) → `CreateUserFile` (registrar) → `CreatePartNumberUserFile` (vincular al PN).

## Arquitectura
- **`file-uploader-core.js`** — núcleo PURO (sin DOM ni red), con golden tests. Toda la inteligencia:
  - `extractPNName(filename)` — nombre de archivo → nombre de PN. Quita extensión y corta en el **primer `__`** (separador del descriptor). Sin `__`, tolera el patrón de copia del legacy crudo (` (2)`, ` copy`).
  - `selectMatchingPNs(nodes, pnName)` — **TODOS** los homónimos exactos (case-insensitive + trim), no el primero.
  - `existingOriginalNames(pnNode)` — set de `originalName` (normalizados) de los archivos YA vinculados al PN. Lee **exclusivamente** `partNumberUserFilesByPartNumberId`.
  - `isAlreadyLinked(set, fileName)` — dedup (case-insensitive + trim).
- **`file-uploader.js`** — orquestador (efectos). Agrupa archivos por PN, pagina la búsqueda, lee existentes, sube 1 vez y vincula a cada homónimo faltante. UI en dark mode + resumen no bloqueante.

## Convención de nombres (lo que produce Cowork)
```
<PN>__<descriptor>.<ext>
```
- `VXC084N528YF53EC__front.jpg`, `80255-553-01__plano.pdf`
- Doble guion bajo `__`. Sin `__` = el nombre completo (sin extensión) es el PN.
- **Varios archivos por PN** = varios descriptores: `<PN>__front.jpg`, `<PN>__back.jpg`, `<PN>__plano.pdf`.

## Hallazgos validados en vivo (sesión 2026-06-25)
Verificado contra el ERP (PN real `3027533` = `VXC084N528YF53EC`, TLC) y la DuckDB:

1. **Shape del bucket de archivos del PN** (de `GetPartNumber`, vars `{partNumberId, usagesLimit, usagesOffset}`):
   ```
   partNumberById.partNumberUserFilesByPartNumberId.nodes[].userFileByUserFileName.{ originalName, name, imagePreviewName, fileFolderByFolderId }
   ```
   - **NO pagina** (solo `nodes`) → trae todos los archivos del PN de un jalón.
   - Dedup se mide contra `originalName`.
   - El PN de prueba tenía 2 archivos (`… front.jpg`, `… back.jpg`) → caso multi-archivo es **real**.
2. **Separador seguro = `__`.** En 23,926 PNs activos de TLC: `__` → **0** colisiones; espacio → 418; guion `-` → 18,884 (79%); `_` simple → 57. Por eso el separador es `__`, no espacio (el legacy crudo usa `<PN> front.jpg`) ni guion.
3. **Homónimos masivos.** 9,449 nombres duplicados (~40% del catálogo), promedio 2.85 copias, **peor caso 15**, ninguno > 20. → "adjuntar a todos" no es edge case. El `.find()` original le pegaba la foto a UN solo PN (el de id más alto) y dejaba miles sin ella.
4. **Casi nadie tiene foto** (128/23,926, 0.5%) → el dump del IBMS llena ese hueco.
5. **`first:20` insuficiente** no por # de homónimos (caben), sino por **ruido de substrings** (búsqueda difusa: `100` trae `1001`, `1002`…). Por eso se pagina y se filtran exactos en el core.

## ⚠️ Buckets de archivos — NO confundir (advertencia del usuario)
Steelhead tiene 11 buckets `*UserFiles*`. El applet toca y dedupea **exclusivamente** el del PN:
- ✅ `partNumberUserFilesByPartNumberId` — **archivos exclusivos del NP** (este applet).
- ❌ `processNodeUserFilesByProcessNodeId`, `recipeNodeUserFilesByRecipeNodeId` — **archivos por nodo (instrucciones)**. El applet NO los lee ni escribe; la idempotencia NO se mide contra ellos. (Test `existingOriginalNames: NUNCA incluye archivos de nodo/instrucciones` lo blinda.)
- Otros: `rackType`, `customer`, `inventoryItem`, `quote`, `receivedOrder`, `workOrder`, `partNumberUserFileByDisplayImageId`.

## Comportamiento (decisiones del usuario)
- **Homónimos → a TODOS** los PNs con ese nombre exacto.
- **Multi-archivo → sufijo `__`** (varios descriptores por PN).
- **Idempotencia → saltar** si el PN ya tiene ese `originalName` (no duplica ni encima). Re-correr es seguro; dump incremental solo sube lo nuevo.
- **PNs archivados → desarchivar → vincular → re-archivar (IMPLEMENTADO v0.3.0).** Para un grupo sin PN activo, se buscan los archivados con `AllPartNumbers(searchQuery, includeArchived:'YES')`, se leen sus archivos + `archivedAt` con `GetPartNumber`, se desarchivan (`UpdatePartNumber{id, archivedAt:null}`), se vinculan los archivos faltantes y se **re-archivan con su `archivedAt` ORIGINAL** (preserva la limpieza de catálogo de mayo). El re-archivado va en `finally` → si algo truena, igual se re-archiva; si el re-archivado falla, se reporta `⚠️ PN … QUEDÓ DESARCHIVADO`.
  - **Verificado en vivo (003397015, reversible):** `AllPartNumbers(includeArchived:'YES')` sí lo encuentra; `UpdatePartNumber{archivedAt:null}` lo hace visible en `SearchPartNumbers`; re-archivar con el string crudo de `GetPartNumber` (`"2026-05-22T07:18:38.31+00:00"`) lo restaura idéntico. El server acepta el `archivedAt` crudo de vuelta → no hace falta normalizar.
  - **Gotcha (incidente probe 2026-06-26):** Python 3.9 `datetime.fromisoformat` NO parsea ms de 2 dígitos (`.31`); dejó un PN desarchivado un momento (restaurado). El applet usa JS y el string crudo, sin ese problema.

## Validación del dump real (2026-06-25)
CSV `mapeo_imagenes_Steelhead.csv` (Cowork) cruzado contra el catálogo TLC: **8,586 archivos**, 6,133 PNs únicos.
- **7,943** archivos → PN activo (se cargan; hasta **17,633 vínculos** por homónimos).
- **642** archivos → PN solo archivado (= **541 PNs** a desarchivar/re-archivar). `SearchPartNumbers` no los ve.
- **1** inexistente (`10060649`, typo probable).
- MTY: solo 47 → el dump es de TLC.
- Convención `__` confirmada limpia incluso con descriptores que llevan espacio/guion (`…__BRIGHT DIP.jpg`).

## Plan de validación pendiente
- [x] **Deploy** v0.2.0 → config **1.7.15** (2026-06-25, `deploy.sh` en main; main había divergido —hashes rotados + load-calculator Fase 2— así que se aplicó SOLO el diff del array, sin pisar). Verificado en vivo (`file-uploader-core.js` HTTP 200).
- [ ] **Prueba chica (12 archivos)**: lote balanceado (8 a PN único + 4 a PNs con 2-3 homónimos). Esperado: 12 subidos, 16 vínculos, 2 grupos homónimos; 2ª corrida → 12 saltados (idempotencia).
- [ ] Confirmar shape `searchPartNumbers.nodes[].{id,name}` en vivo (hoy se asume `n.name`/`n.id`).
- [ ] **Llevar a main el test + bitácora** (`tools/test/file-uploader-core.test.js`, este doc): el deploy solo movió `remote/`; viven en `workbench`.
- [ ] **Sincronizar `workbench` con `main`** (config divergió: hashes vigentes + `load-calculator-modal.js`).

## Pendientes / mejoras
- **Memory hardening si el dump es masivo (>200 archivos):** el applet es secuencial y no acumula respuestas, pero `GetPartNumber` es pesado (504 campos) y los binarios de imagen pasan por memoria. Antes de un dump de miles, invocar el skill `memory-hardening-applets` y considerar `host-cleanup-shared` (Apollo cache drain periódico + mem monitor). Hoy NO está integrado.
- **`display_image_id`:** el applet no marca foto principal del PN. Posible mejora: setear el primer `__front`/`__principal` como display image.
- **Manifiesto CSV** (descartado por YAGNI): si el naming codificado se vuelve frágil, mapear archivo→PN explícito.

## Lecciones
- **CSS propio obligatorio (bug 2026-06-26).** El applet usaba las clases `.dl9-*` pero NO inyectaba su CSS; ese CSS lo definen otros applets (archiver/po-comparator/bulk-upload) cada uno con su `<style>`. file-uploader corre **aislado** (su array no incluye a ninguno de esos), así que el overlay de progreso y el resumen se creaban **invisibles** (sin `position:fixed`/fondo/centrado). Síntoma: "no mostró nada de resumen". La v0.1.0 lo tapaba con `alert()`. **Fix:** `ensureStyles()` inyecta un `<style id="sa-uploader-styles">` propio (idempotente) — no depender de otro applet. **Regla general:** cualquier applet que use clases `dl9-*` debe inyectar su propio CSS. La lógica de negocio NO estaba rota (se verificó en vivo que las fotos sí se vincularon, incl. fan-out a homónimos); era 100% un problema de UI.

## Historial
- **0.3.0 (2026-06-26):** ciclo de archivados (desarchivar→vincular→re-archivar con `archivedAt` original, re-archivado en `finally`) + reporte accionable (cuenta **archivos seleccionados**, desarchivados/re-archivados, **lista + exporta CSV** de no encontrados). Mutaciones validadas en vivo (reversible). Pendiente: deploy + memory hardening para el full run.
- **0.2.1 deploy (2026-06-26):** config **1.7.17**. Fix CSS dl9 (UI invisible) + `run()` siempre muestra resumen (try/finally + try por grupo). Causa raíz vía systematic-debugging; lógica confirmada correcta en vivo.
- **0.2.0 deploy (2026-06-25):** publicado a gh-pages, config **1.7.15**. Validado el dump real (8,586 archivos). Próximo: ciclo de archivados (desarchivar→vincular→re-archivar) + memory hardening, tras prueba chica.
- **0.2.0 (2026-06-25):** refactor a carga masiva inteligente. Núcleo puro + 18 tests. Homónimos→todos (antes `.find()` solo el más reciente), multi-archivo por PN (agrupación + convención `__`), idempotencia vs bucket del PN, paginación de búsqueda, resumen no bloqueante en dark mode. Shape y métricas validados en vivo.
- **0.1.0:** versión inicial — 1 archivo = 1 PN exacto (`.find()`), sin dedup, `alert()` final, `first:20`.
