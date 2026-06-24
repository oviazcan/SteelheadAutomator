# `spec-migrator` (bundle "Ajuste Masivo de Specs")

Bundle del menú **Ajuste Masivo de Specs** (icono 🔀, categoría "Números de Parte"). Concentra acciones que **ajustan o validan** specs ya aplicadas a PNs — distinto del bundle `spec-params-bulk` (Calidad), que **edita parámetros** vía XLSX.

Scripts: `steelhead-api.js` + `spec-migrator.js`. Sin VERSION constant exportado; las versiones se trackean por acción en este doc.

## Acciones

| Acción | Función | Origen |
|---|---|---|
| `run-spec-migrator` (Migrar Specs) | `SpecMigrator.run` | original 2024 |
| `assign-pending-params` (Asignar Params Pendientes) | `SpecMigrator.assignPendingParams` | original 2024 |
| `resolve-conflicts` (Resolver Conflictos) | `SpecMigrator.resolveConflicts` | original 2024 |
| `validate-duplicate-params` (Validar params duplicados) | `SpecMigrator.runDuplicateParamsValidator` | **0.5.5 — 2026-05-26, bump config 1.5.4** |

---

# Refactor 2026-06-24 (config 1.7.4) — `GetSpecFieldSpec` dividido por Steelhead → `GetSpecFieldPartNumbers`

## Síntoma
Steelhead **partió** la persisted query `GetSpecFieldSpec` en queries por-tab (detectado por el hash-scanner, scan `2026-06-24_124125`). El hash viejo `4da5a578…` quedó STALE y la operación **ya no existe con ese nombre** — `assignPendingParams` (Phase 4) habría tronado al pedir PNs sin asignar.

## Causa raíz
El viejo `GetSpecFieldSpec` traía en UNA llamada los 3 tabs (PartNumbers/Treatments/WorkOrders) + `specFieldSpecById`. Steelhead lo dividió en `GetSpecFieldSpecDetails`, `GetSpecFieldPartNumbers`, `GetSpecFieldTreatments`, `GetSpecFieldWorkOrders`, `GetSpecFieldSpecData`.

## Fix (acotado)
`spec-migrator.js` **solo** usaba `searchPartNumbers` de esa query (los PNs sin asignar de un field) — `isGeneric/defaultValues/specFieldBySpecFieldId` ya venían de `SpecFieldsAndOptions` (que NO rotó). Por eso bastó **una** query de reemplazo, no las 5:
- `getSpecFieldSpec()` ahora llama **`GetSpecFieldPartNumbers`** (hash `0e49e0ee…`, http 200) con `{specFieldSpecId, partNumberUnassignedActive:true, partNumberSpecFieldParamActive:false, searchQuery:'', first, offset, orderBy:['NAME_ASC']}`.
- Cambio de root key: antes `searchPartNumbers.{totalCount,nodes}`, ahora **`pagedData.{totalCount,nodes}`**. La función **adapta** `pagedData → {searchPartNumbers:{totalCount,nodes}}` para no tocar el caller (Phase 4, líneas ~1063-1075).
- `GetSpecFieldSpec` **removido** de `config.json` (muerto, ningún otro applet lo usaba).

## Pendiente de validación
Run real de `assignPendingParams` (uso manual del applet) para confirmar la paginación end-to-end. Hash validado http 200 por separado; cadena no probada en vivo aún.

---

# `validate-duplicate-params` 0.5.5 (2026-05-26, bump config 1.5.4) — Memory hardening completo (EJE A + B + mem monitor + virtualización)

## Síntoma / petición

Tras 0.5.4 (fix preferNull + wrongSfp) el validator funciona correcto pero seguía sin la red de seguridad completa del skill `memory-hardening-applets`:
- **Sin mem monitor** — no había forma de ver el crecimiento del heap en runtime; el guardrail a 88% nunca podía dispararse porque no había trigger.
- **Datadog/Apollo cleanup inline** — copia local del patrón rompía la idempotencia compartida con otros applets co-residentes (latches `window.__sa_dd_stopped` quedaban "huérfanos" si el orden de carga cambiaba).
- **Periodic drain por chunk de onProgress** — no por PN procesado real, así que en runPool con concurrency=6 el drain se desfasaba.
- **Sin AbortController** — al cancelar, los fetches en vuelo (hasta 6 GetPartNumber + sus retries) seguían martillando GraphQL durante segundos.
- **Sin checkpoint / resume** — un OOM perdía toda la corrida; el usuario tenía que re-cargar el CSV completo desde cero.
- **Sin virtualización del preview** — la tabla de issues con 500+ filas creaba ~5-15k nodos DOM upfront.
- **CSV raw rows retenidos** — el array `rows` (4000 × 70 cells) vivía toda la corrida porque `csvText` y `rows` quedaban capturados en el closure de `dupRunScanFromCsv`.

## Cambios

### EJE A — memoria propia del applet

| Item | Línea(s) | Cambio |
|---|---|---|
| Slim CSV + nullify rawArr/csvText | `dupRunScanFromCsv` | `rows = null; csvText = null` justo después del parse a `csvParts`. El GC libera el array crudo y el string del CSV en lugar de retenerlos los 3-30 min que dura el scan. |
| Liberar `detail = null` por worker | scan + apply | (ya estaba en 0.5.3) — confirmado intacto. |
| Clear post-apply | fin de `dupRunApplyCsv` | Tras render del resultado: `dupClearResume()` + `dupState.csvSelections = new Map()` + nullear `csvUnresolved/csvFetchErrors/csvItems`. No esperar a `closePanel`. |
| Cleanup en closePanel | `dupClosePanel` | (ya estaba en 0.5.2) + ahora detiene `memMonitor` y aborta `abortCtrl` antes de soltar refs. |
| Seed pattern previewByPN | `dupCsvClassifyPN` | (ya estaba en 0.5.2 con `savePnSeed`) — confirmado: el item solo retiene `{ pnId, pnName, customer, quoteIBMS, savePnSeed{8 fields}, issues[liteRows] }`, NO el `detail` completo. |

### EJE B — memoria del host SPA

| Item | Línea(s) | Cambio |
|---|---|---|
| Migración a `host-cleanup-shared.js` | `dupApolloCacheDrain`, `dupStopHostJobs` | Wrappers de 1 línea sobre `window.SteelheadHostCleanup.apolloCacheDrain()` / `.stopDatadogSessionReplay()`. Latches comparten estado real con bulk-upload, auditor y cualquier futuro applet co-residente. |
| `host-cleanup-shared.js` en config | `remote/config.json` spec-migrator scripts | `["scripts/steelhead-api.js", "scripts/host-cleanup-shared.js", "scripts/spec-migrator.js"]`. |
| `makePeriodicDrain(50)` atómico | const `dupPeriodicDrain` | Reemplaza el `if (done % 50 === 0) dupApolloCacheDrain()` en onProgress (que contaba chunks) por una llamada al fin del worker (que cuenta PNs reales). Aplica a scan **y** apply. |
| Mem monitor con guardrail | `dupEnsurePanel` | Crea `HOST.createMemMonitor({ warnPct:70, critPct:85, guardrailPct:88, onGuardrail: dupHandleGuardrail })`, arranca en `panel open` y para en `closePanel`. Pinta `Mem: XXMB/YYMB (NN%)` en span `[data-ctrl=dup-mem]` del header con clases `sa-mem-warn` / `sa-mem-crit`. |
| `onGuardrail` con resume | `dupHandleGuardrail` | A 88%: persiste `{ ts, pct, csvFileName, customerFilter, specFilter, processedCount, processedIds }` a `localStorage[sa-specm-dup-resume-v1]`. Aborta `runId++` + `abortCtrl.abort()`. Renderiza modal con instrucción de reload. **NO intenta continuar.** |
| `AbortController` por scan/apply | `dupState.abortCtrl` | Cada `dupRunScanFromCsv` / `dupRunApplyCsv` crea `new AbortController`. Cancel + guardrail llaman `.abort()`. Los workers checan `aborted` antes de entrar al fetch. (Retries de `dupWithRetry` propagan abort error sin loop.) |

### #11 — Virtualización del preview DOM

- Refactor de `dupRenderCsvResults`: extrae `buildRow(it)` + `renderNextChunk()`. Render inicial: primeras 50 filas. Sentinel debajo del `<table>` con `IntersectionObserver` (`root=wrap`, `rootMargin:200px`) — al entrar al viewport del scroll del panel, renderiza siguiente chunk. Fallback sin IO: click manual en el sentinel.
- Resultado: 4000 PNs con issues = 50 nodos DOM iniciales (~250 cells) vs ~20k antes.

### #checkpoint UX

- Banner en `dupRenderFilterPanel` si hay `localStorage[sa-specm-dup-resume-v1]`: muestra `pct`, `csvFileName`, `processedCount` y minutos desde el evento. Botón "Descartar checkpoint" llama `dupClearResume()`.
- **Reanudación real** (skip pnIds en `dupCsvResolvePnIds`): pendiente derivado — el banner solo informa. Implementar cuando el guardrail realmente dispare en un CSV real (no antes de tener evidencia).

## Plan de validación

- [ ] Recargar extensión, abrir validator → confirmar que el span `Mem: XXMB/YYMB (NN%)` aparece en el header del panel y se actualiza cada 2s.
- [ ] Correr CSV de los 4 clientes → confirmar que la tabla de preview muestra "Mostrando 50 de N — desplázate para ver más" y al hacer scroll se cargan chunks adicionales.
- [ ] Cancelar mid-scan → confirmar que el contador de PNs se congela inmediato (no sigue subiendo durante 5-10s como en 0.5.4).
- [ ] Simular guardrail (devtools: `window.performance.memory` mock o forzar `dupHandleGuardrail(88)` desde consola) → confirmar que aparece el modal de reload, `localStorage[sa-specm-dup-resume-v1]` está poblado, y al reload aparece el banner.
- [ ] Verificar que tras `Apply` exitoso el `localStorage[sa-specm-dup-resume-v1]` queda limpio.
- [ ] Heap snapshot en DevTools antes y después de un scan de 4000 PNs → confirmar que el array de `rows` crudo del CSV (4000+ × 70 cells de string) NO aparece retenido.

## Pendientes derivados

- **Reanudación real** desde checkpoint (skip `processedIds` en `dupCsvResolvePnIds`). Solo cuando tengamos evidencia de OOM real.
- **Aplicar el mismo hardening al scan mode no-CSV** (`dupRunScan`): hoy no llama `dupStopHostJobs` ni periodic drain — corre sobre un universo más chico (con filtros), pero si el usuario corre "sin filtros" entra al mismo régimen.
- **#113 Audit memoria en todas las applets**: bulk-upload y auditor ya están migrados al módulo compartido; quedan pendientes los demás del índice.

---

# `validate-duplicate-params` 0.4.3 (2026-05-25, bump config 1.4.38) — regla null-only por SpecField (alineación con bulk-upload 1.4.38)

## Síntoma / petición
Tras 0.4.2, el usuario probó el validator sobre PN 3027939 y observó que el toggle global "Archivar params con processNodeId = NULL" estaba al revés de la regla buena: bulk-upload 1.4.38 ahora exige que el row vivo de cada `SpecField` tenga `processNodeId=null`. El toggle hacía justo lo contrario.

Adicionalmente, el usuario clarificó el modelo:
> "debes pensar que los specfields 'agrupan' los parámetros… SOLO un parámetro por specfield, nunca más de uno"

Y la regla para grupos con sfpIds distintos pero **mismo nombre**:
> "si los dos parámetros se llaman igual, dejamos el que está null… para el manual, sí deben aparecer radios pues hay dos opciones DIFERENTES… el radio seleccionado default debe ser el que trae proceso (no para dejarle el proceso, sino porque es el que insertó bulk upload que está validado)"

## Regla nueva (absoluta — sin toggle)
Por cada grupo de duplicados bajo un `specFieldSpecId` único:

| Caso | Clasificación | Acción |
|---|---|---|
| 1 sfpId, ≥1 NULL | `autoDecidable=true` | Conservar NULL más reciente; archivar el resto (otros NULLs + todos los con processNode). |
| 2+ sfpIds con MISMO `paramName` | `autoDecidable=true` | Igual al caso 1 — el nombre repetido confirma duplicación pura. |
| 2+ sfpIds con `paramName` DISTINTO | `autoDecidable=false` (manual) | Radios para elegir; **default = sfpId con processNode** (es el que bulk-upload acaba de validar contra el catálogo). El validator igualmente insertará el winner como NULL y archivará los rows con processNode. |
| 1 sfpId, sin NULL | `autoDecidable=false` (manual) | El validator sólo archiva — no inserta. Bulk-upload re-pasará y dejará el NULL. |

## Cambios de código
- `spec-migrator.js:2114-2150` — header del bloque reescrito con casos arriba.
- `spec-migrator.js:2469-2515` — `dupRunScan` calcula `sameName` (`mappedParams.every(p => p.sfpName === firstName)`) y `autoDecidable = (sameSfp || sameName) && hasNull`.
- `spec-migrator.js:2558` — banner púrpura del toggle eliminado; reemplazado por nota informativa "Regla absoluta: 1 row vivo por SpecField con `processNodeId=null`. Sin toggle."
- `spec-migrator.js:2725-2745` — `dupComputeAutoWinner(g)` simplificado:
  ```js
  function dupComputeAutoWinner(g) {
    if (!g.autoDecidable) return g.params[0].rowId;
    const nulls = g.params.filter(p => !p.processNodeId);
    return (nulls.length ? nulls[0] : g.params[0]).rowId;
  }
  ```
- `spec-migrator.js:2743-2755` — nuevo helper `dupManualDefaultWinner(g)`: default radio = primer param con `processNodeId !== null` (es el row "validado" por bulk-upload).
- `dupState.archiveNullProcessNode` eliminado (default ON o OFF dejaron de tener sentido).

## Bug encontrado durante validación con DevTools (tools/test-null-param-fix.js)
El primer apply sobre PN 3027939 archivó correctamente pero el insert posterior falló:
`Variable "$input" got invalid value "25611423" at "input.paramsToApply[0].specFieldParamId"; Int cannot represent non-integer value`

Causa: al normalizar `sfpId` a String para matching de radio buttons, el insert payload mandaba String donde el schema exige `Int`. Fix en el script DevTools **y en el validator**: `Number(ins.specFieldId)` / `Number(ins.specFieldParamId)` antes de armar `paramsToApply`. (Recuperación del PN 3027939: el usuario lo arregló a mano en la UI de Steelhead.)

## Lección
- **SpecField es el contenedor**. Cualquier validador / dedup / cleanup que agrupe por `sfpId` está roto por construcción — agrupar siempre por `specFieldSpecBySpecFieldSpecId.specFieldBySpecFieldId.id`.
- **`sameName` vs `sameSfp`** son dos formas de la misma duplicación: una es el mismo SpecFieldParam reinsertado, la otra es el catálogo redefinido con sfpId nuevo pero nombre idéntico. Ambas se resuelven igual.
- **El radio default importa**. El usuario eligió "el que trae proceso" no porque quiera conservar el proceso, sino porque ese row es el que bulk-upload acaba de validar contra el CSV — es la fuente de verdad para sfpId.
- **Coerce a Int en boundary del schema**. Si el código interno normaliza IDs a String para keys de Map o matching de UI, el insert payload debe `Number(...)` antes de mandar.

## Pendiente
- [ ] Feature CSV-mode (#110): permitir cargar el CSV de bulk-upload en el validator para que use `wantedSelections` del CSV en vez de "el más reciente" — así el validator puede corregir PNs cargados con bulk-upload viejo sin re-correr toda la carga.
- [ ] audit-incomplete-pns (#111): añadir criterio `duplicate-params per SpecField` al reporte de PNs incompletos.

---

# `validate-duplicate-params` 0.4.2 (2026-05-26, bump config 1.4.37) — UX auto-decision toggle

## Síntoma / petición
Después del fix 0.4.1, el usuario vio la tabla de PN 3027938 (10 params activos → 5 grupos duplicados). Observación: 4 de los 5 grupos eran **el MISMO `SpecFieldParam`** repetido (mismo `sfpId`, mismo nombre "Sí o No" / "Elección") y sólo diferían por `processNodeId` (uno `null`, otro `223469`). Sólo 1 grupo (Espesor) tenía sfpIds distintos ("5.8 - 8.89 µm" vs "7.62 - 15.24 µm").

Cita del usuario:
> "cuando el parámetro es igual, no me pregunte cuál quiero dejar uno a uno, si son iguales, pues que ni me pregunte, si uno tiene processNodeId y otro no, que sea un toggle global: Archivar el processIDNull o algo así si no se marca se archiva el otro. Obvio para los que los parámetros son diferentes como en este caso el espesor, SÍ debo de seleccionar yo cuál dejar."

## Clasificación de grupos (nueva)
Cada grupo ahora incluye 2 flags computados en `dupRunScan`:

- `sameSfp` — todos los params del bucket comparten `sfpId` (caso "copia accidental con/sin proceso").
- `autoDecidable` — `sameSfp === true` AND existe ≥1 param con `processNodeId` AND ≥1 sin (`null`). Sólo en este caso el toggle global decide; si todos son null o todos tienen processNode (raro), cae a "manual" para evitar ambigüedad.

## UI
- **Stats bar**: agrega `Auto-decidibles` y `Manuales`.
- **Toggle global** (sólo si hay auto-decidibles): banner púrpura con checkbox `Archivar params con processNodeId = NULL en los N grupos auto-decidibles…`. Default **ON**. Al togglear, recomputa el `winnerRowId` de todos los autoDecidable y re-renderiza la tabla.
- **Pill por grupo autoDecidable**: reemplaza los radios con un panel `⚙ AUTO (mismo param, N filas)` y filas `✓ CONSERVA` / `✗ ARCHIVA` con `row#` + `pn#` (o `· NULL`). El usuario no escoge nada manualmente — la decisión sigue al toggle.
- **Radios manuales**: persisten sin cambios para grupos con `autoDecidable === false` (caso Espesor).
- **Ignorar**: se mantiene en autoDecidable también (el usuario puede excluir un grupo auto del fix si lo ve raro).

## Wiring
- `remote/scripts/spec-migrator.js:2228` — agrega `dupState.archiveNullProcessNode: true`.
- `spec-migrator.js:2438-2484` — clasificación `sameSfp` / `autoDecidable` + winner inicial.
- `spec-migrator.js:2659-2675` — nuevo helper `dupComputeAutoWinner(g)` (regla: si toggle=true, pool=params con processNodeId; el más reciente gana).
- `spec-migrator.js:2503-2545` — banner toggle global + handler que recomputa winners y re-renderiza.
- `spec-migrator.js:2581-2614` — branch `if (g.autoDecidable)` que pinta pill en vez de radios.
- `spec-migrator.js:2776` — XLSX agrega columna `Modo` (AUTO/MANUAL) en la hoja Detectados.

## Por qué `autoDecidable` y no sólo `sameSfp`
Si los dos params son del mismo sfp PERO los dos tienen processNodeId distinto (o ambos null), el toggle no puede decidir qué archivar sin pedirle al usuario. Mejor caer a radios manuales que tomar una decisión silenciosa basada en `max(rowId)` que el usuario no vio venir.

## Pendiente derivado (importante, ya en backlog #105)
**RCA de cómo aparecen estos duplicados**: el usuario apunta a bulk-upload. La hipótesis es que al recargar un PN, el flujo no archiva los params previos antes de crear los nuevos. Ver `docs/applets/bulk-upload.md` cuando se aborde — si se confirma, fix en el script de origen evita seguir generando basura mientras este validator la limpia.

## Plan de validación 0.4.2
- [ ] Correr scan en PN 3027938: 5 grupos, banner muestra "Auto-decidibles: 4 · Manuales: 1".
- [ ] Default ON: pills muestran CONSERVA = `pn#223469`, ARCHIVA = `NULL` en los 4 auto.
- [ ] Desmarcar toggle: pills invierten (CONSERVA = NULL, ARCHIVA = `pn#223469`). Re-marcar revierte.
- [ ] Grupo Espesor sigue mostrando radios manuales — confirmar selección persiste al togglear el banner.
- [ ] Aplicar fix con toggle ON → 4 NULLs archivados + 1 manual aplicado.
- [ ] XLSX bitácora "Detectados" tiene columna `Modo` con `AUTO`/`MANUAL` correctas.

---

# `validate-duplicate-params` 0.4.1 (2026-05-25, bump config 1.4.36) — Fix shape de agrupación

## Síntoma
El usuario corrió 0.4.0 contra todo el dominio: ~1 hora de scan, reportó **0 duplicados**. Pero tenía PNs reales con 2+ params en el mismo SpecField/Spec (verificado manualmente en UI: PN 3027938 / 3027939 FEDERAL-MOGUL con spec "1.28.032 (Níquel)" mostraba duplicados en "Aspecto Visual", "Espesor" y otro).

## Diagnóstico
El response de `GetPartNumber` en `partNumberSpecFieldParamsByPartNumberId.nodes[]` NO expone `partNumberSpecId`. El shape real (confirmado con scan_results_2026-05-25_201858.json, `GetPartNumber` count=2306 errCount=0):

```
{
  id, archivedAt, specFieldId, processNodeId, processNodeOccurrence,
  locationId, geometryTypeSpecFieldId,
  specFieldParamBySpecFieldParamId: {
    id, name, specFieldSpecId,
    specFieldSpecBySpecFieldSpecId: {
      id (= specFieldSpecId), specId,
      specBySpecId: { id, idInDomain, name, ... },
      specFieldBySpecFieldId: { id, name, ... }
    }
  }
}
```

`p.partNumberSpecId` → `undefined`. El código 0.4.0 hacía:
```js
const psId = p.partNumberSpecId;
if (!psId || !sfId) continue;   // ← descartaba TODOS los params
```

Resultado: `buckets` siempre vacío, 0 grupos. Silencioso porque el log solo decía "0 grupos duplicados" sin advertir que `psId` venía undefined.

Comprobado contra el sample del scan (PN 3027939, 12 params activos): la key `specFieldId` da 3 grupos duplicados; `specFieldSpecId` da los mismos 3; la key (sfs.id, processNodeId, locationId) da 0 (porque uno tiene processNodeId null y otro no — pero el usuario quiere flag-earlos como duplicados igual: la regla operacional es "uno y sólo uno por SpecField de Spec").

## Fix
- `remote/scripts/spec-migrator.js:2387` — quitado `usagesLimit/usagesOffset` de `GetPartNumber({ partNumberId: pn.id })` (el UI nativo usa `usagesLimit:10`; pasar 0 era sospechoso y el shape full ya trae todo lo necesario).
- `remote/scripts/spec-migrator.js:2397-2456` — reescritura de la agrupación:
  - Key: `specFieldParamBySpecFieldParamId.specFieldSpecBySpecFieldSpecId.id` (= `specFieldSpecId`).
  - Eliminado `psMap` (innecesario — el specName/fieldName vienen anidados en el shape del param).
  - Filtro de spec se aplica per-param antes de bucketizar.
  - Expone `processNodeOccurrence` y `locationId` en `params[]` para diagnóstico futuro.

## Hallazgo bonus
La función `getPNDetail(partNumberId)` original (`spec-migrator.js:74-79`) también usa `usagesLimit: 0, usagesOffset: 0`. NO se tocó porque las 3 acciones originales (Migrar Specs / Asignar Pendientes / Resolver Conflictos) llevan meses operando con eso. Si en algún momento se sospecha de comportamiento raro en esas acciones, ahí hay un candidato (el UI nativo usa `usagesLimit:10`; bulk-upload usa `1`; "0" es valor no-natural).

## Lecciones
- **Asumir un campo existe sin verificarlo en el response real es la regla #1 de bugs silenciosos.** Mi mental model decía "partNumberSpecId es la FK natural" (vista en mutations), pero el query no la expone en ese node. El scan tenía el responseSchema completo desde el día 1 — un grep antes de codificar habría evitado el bug entero.
- **Logging defensivo cuando hipotetizas el shape**: si `psId = undefined` causaba descartar TODOS los params, el log debió haber tenido un counter `paramsRejectedNoPsId` que disparara una warning cuando >50% de los params se descartaban.
- **Probar contra un PN conocido-con-duplicados antes del scan completo**: 1 hora perdidos pudieron ser 30 segundos con un solo `GetPartNumber({partNumberId: 3027938})` en DevTools.

## Plan de validación (vigente)
- [ ] Correr scan con filtro `cliente=FEDERAL-MOGUL` y verificar que aparece el grupo de PN 3027938/3027939 (espesor, aspecto visual y otro).
- [ ] Aplicar fix sobre un grupo controlado, confirmar archivo en UI.
- [ ] Re-correr scan y confirmar 0 dups en ese PN.
- [ ] Revertir manualmente con `UpdatePartNumberSpecParam{id, archivedAt:null}` para confirmar reversibilidad.

---

# `validate-duplicate-params` 0.4.0 (2026-05-25, bump config 1.4.35) — INICIAL, bug de shape

Detecta y limpia PNs con >1 param activo para el mismo `(partNumberSpecId, specFieldId)` — el caso "espesor con 3 parámetros, uno con processNode default y dos sin" que aparece después de cargas masivas mal dedupeadas.

**Ubicación correcta** (corrección del usuario): vive en el bundle `spec-migrator` (Ajuste Masivo de Specs), NO en `spec-params-bulk` (Carga masiva Spec Params). La regla: ajuste + validación van en spec-migrator; edición de parámetros en spec-params-bulk.

**Flujo:**
1. **Filtros opcionales** — `cliente` (substring uppercase, contra `customerByCustomerId.name`) y/o `spec` (substring lowercase, contra `specBySpecId.name`). Vacío = todos los PNs activos.
2. **Fase 1: `AllPartNumbers` paginado** (`first:500`, `NAME_ASC`) con `dupWithRetry`. Filtra archivedAt y aplica filtro cliente al vuelo.
3. **Fase 2: `dupRunPool(allPNs, GetPartNumber, 6)`** con `usagesLimit:0`. Por cada PN:
   - Construye `psMap: partNumberSpecId → {specId, specName, specIdInDomain}` solo con specs activas.
   - Si hay `specFilter` y ninguna spec activa matchea, descarta el PN.
   - Agrupa `partNumberSpecFieldParamsByPartNumberId.nodes` activos por `(partNumberSpecId, specFieldId)`.
   - Flagea grupos con `length >= 2`. Resuelve `fieldName` cruzando `pnSpecs[].specBySpecId.specFieldSpecsBySpecId.nodes`.
   - Default winner = mayor `id` (más reciente). Persiste en `dupState.decisions` como `Map<groupKey, {winnerRowId, ignored}>`.
4. **Tabla interactiva** (DOM API + `textContent`, cero `innerHTML` para datos) con stats bar: PNs revisados, PNs con duplicados, grupos, params a archivar.
   - Por grupo: PN | Cliente | Spec | SpecField | Radios (1 por param, preselecciona winner, muestra `row#…·sfp#…·pn#…·más reciente`) | Checkbox **Ignorar**.
   - Cambiar radio re-pinta loser/winner colors; toggle ignorar grisea fila y la excluye del contador del footer.
5. **Aplicar fix** — `confirm()` defensivo, luego `dupRunPool(tasks, UpdatePartNumberSpecParam{archivedAt:nowISO}, 3)` con `dupWithRetry`. Bitácora XLSX descargable (hojas **Detectados** con decisión por fila, **Aplicadas**, **Errores**). También se puede descargar el snapshot pre-aplicación desde la tabla.

**Decisiones del usuario (cerradas antes de implementar):**
- Universo de escaneo: todos los PN activos + filtro cliente + filtro spec, ambos opcionales y combinables.
- Default winner: mayor `id` (más reciente).
- Modo fix: archivar (reversible) vía `UpdatePartNumberSpecParam{id, archivedAt: ISO}` — el mismo mecanismo que `archiveParam(paramId)` en `spec-migrator.js:130`, reversible con `archivedAt: null`.

**Wiring:**
- `remote/scripts/spec-migrator.js` — bloque al final del IIFE (helpers `dup*` con CSS namespace `sa-specm-dup-*`, tema púrpura `#8b5cf6`). Helpers renombrados con prefijo `dup` para no colisionar con identificadores existentes del módulo.
- `remote/config.json` (línea ~495) — 4ª acción del bundle con label "🧹 Validar params duplicados".
- `extension/background.js` — case dedicado `validate-duplicate-params` que inyecta XLSX library + bundle de spec-migrator y llama `SpecMigrator.runDuplicateParamsValidator()`.

**Cancelación:**
- Estado local `dupState.runId` (no usa la infraestructura `bailIfStale` del bulk-upload — spec-migrator no la tiene). Cada función async guarda `myRunId = dupState.runId` al entrar; vuelve a comparar antes de re-pintar UI o aplicar mutaciones. Cerrar el panel hace `dupState.runId++` y aborta in-flight.

**Lecciones:**
- **No reusar el dedup del propio migrator** — `spec-migrator.js` (la sección original de conflicts) colapsa con `new Set(activeParams.map(p => p.specFieldParamBySpecFieldParamId.id))`, lo que silenciosamente esconde duplicados que difieren por `processNodeId`. Este validador usa el shape correcto: `(partNumberSpecId, specFieldId)` como key, sin colapsar por sfpId — así un grupo de 3 espesores con processNode null/default/A se ve como 3 rows, no 1.
- **`UpdatePartNumberSpecParam` es la mutation más simple para archivar un row individual** — el migrator ya usa este patrón en `archiveParam(paramId)`. Confirma que `archivedAt: ISOString` archiva, `archivedAt: null` revierte. Reversible operativamente.
- **DOM API en lugar de `innerHTML` para tabla con datos del usuario.** Los nombres de PN/cliente/spec pueden venir con caracteres especiales. La tabla se arma con `createElement` + `textContent`. Coherente con el pendiente XSS del audit (#2 medio): esta action lo hace bien desde el inicio.
- **XLSX library debe inyectarse explícitamente** — el bundle de spec-migrator no la cargaba (las 3 acciones originales no la necesitan). El case nuevo de background.js la inyecta antes del bundle para tener `window.XLSX` disponible al descargar la bitácora.

**Plan de validación pendiente:**
- [ ] Correr scan con filtro `cliente=BRP` y verificar que aparecen los grupos conocidos (espesor x3).
- [ ] Aplicar fix sobre un grupo controlado (PN de prueba), confirmar que el row queda archivado en Steelhead UI.
- [ ] Re-correr scan y confirmar que el grupo ya no aparece.
- [ ] Revertir manualmente con `UpdatePartNumberSpecParam{id, archivedAt:null}` para confirmar reversibilidad.

---

# `validate-duplicate-params` 0.5.0 (2026-05-25, bump config 1.4.39) — Modo CSV multi-cliente

Segundo modo de la acción: en lugar de escanear todo el catálogo, se carga **un CSV de bulk-upload V10** y solo se revisan los PNs listados ahí. Pensado para corregir PNs que se crearon con duplicados en cargas previas (antes del fix 1.4.38), sin re-correr la carga masiva.

**Por qué existe (no es estética):**
Después del fix 1.4.38, una **carga nueva** ya no genera duplicados. Pero los PNs creados antes siguen sucios. El modo "scan global" (0.4.x) los encuentra, pero no sabe **cuál es el wanted** según el CSV original — solo sabe que hay >1 row vivo por SpecField. El modo CSV resuelve: el wanted es el `sfpName` que el CSV pide, lo demás se archiva.

**Flujo (file picker en el panel de filtros existente):**

1. **Parse CSV** (`dupCsvParseCSV` RFC 4180-ish + `dupCsvParseRows`):
   - Salta filas header (`PARÁMETROS` / `Archivado` / `V/F` / `Texto` / `Número de Parte`).
   - Extrae `{ pn (F=5), customer (E=4), quoteIBMS (BK=62), specs[{name,param}] }`.
   - Specs vienen en columnas `AH=33` y `AJ=35`, split por `" | "` → `{ name, param }`. Si no hay separador, el param queda vacío (caso "spec con 1 solo param en catálogo").

2. **Resolución multi-cliente con dedup QuoteIBMS** (`dupCsvResolvePnIds`):
   - Pre-fetch global `AllPartNumbers` paginado (`first:500`), filtrado archivedAt.
   - Index `Map<"CUSTOMER|PN_UPPERCASE", node[]>`.
   - Por cada `csvPart`:
     - **0 candidatos** → `unresolved` con reason `no encontrado`.
     - **1 candidato** → directo.
     - **2+ candidatos** → match por `customInputs.DatosAdicionalesNP.QuoteIBMS` (parseo defensivo: `customInputs` puede venir como string o como objeto, dependiendo del schema). Match único → resuelve; 0 match → unresolved; 2+ match → unresolved (homónimos con misma QuoteIBMS, requiere intervención manual).
   - Devuelve `{ resolved, unresolved, ambiguousByQuote (info-only), totalNodes }`.

3. **Fetch detalle + clasificación** (`dupRunPool(resolved, GetPartNumber, 6)` + `dupCsvClassifyPN`):
   - Por PN: agrupa rows vivos por `specFieldId` (regla 1.4.38 = 1 row vivo por SpecField, processNodeId=null).
   - Index del CSV: `Map<specName_lowercase, {name,param}>`.
   - Por cada SpecField del live: si el CSV menciona esa Spec, mira el `csvParam` y busca el sfpName que coincida case-insensitive contra el live. Resultado por SpecField:

   | status | Significado | Acción al aplicar |
   |---|---|---|
   | `ok` | wanted vivo + sin processNode + sin duplicados | (omitido) |
   | `duplicateRemove` | wanted vivo NULL + hay losers o procesNode en otros | archive losers |
   | `processNodeRewrite` | wanted vivo PERO con processNodeId ≠ null | archive wanted + losers + insert NULL del mismo sfp |
   | `wrongSfp` | el sfpName del CSV no está vivo en el PN | flag, no se aplica (no se resuelve sfpId desde catálogo en MVP) |

4. **Render** (`dupRenderCsvResults`): tabla por PN con checkbox **Aplicar**, contador de issues por status (color codes), preview de qué se va a archivar / qué NULL se va a insertar. Stats bar con totales. PNs cuyos issues son **todos** `wrongSfp` quedan con checkbox deshabilitado (no aplicable).

5. **Apply** (`dupRunApplyCsv`, pool 3): 1 `SavePartNumber` por PN seleccionado. El input combina **en la misma mutation**:
   - `paramsToApply[]` con `{ specFieldId, specFieldParamId, processNodeId:null, ... }` para todos los `wantedNullSfp` (insert NULL del sfp correcto).
   - `partNumberSpecFieldParamsToArchive[]` con todos los `archiveIds` (losers + wanted-con-processNode).
   - Mismo shape exacto que STEP 6b de bulk-upload 1.4.38.
   - **Casts obligatorios:** `Number(specFieldId)` y `Number(specFieldParamId)` — el schema exige `Int`, no `String`.

**Decisiones cerradas con el usuario antes de codear:**
- File picker se inserta en el panel de filtros actual (no en una pestaña aparte), con UI púrpura punteada para diferenciarlo del scan global.
- Confirmación se hace **por PN problemático** vía el checkbox individual (no 1 confirm masivo) — el `confirm()` solo es defensivo antes de la batch.
- Si el wanted está vivo pero tiene `processNodeId`, se **re-escribe como NULL** (archive + insert NULL), no se intenta `UpdatePartNumberSpecParam{processNodeId:null}` (Steelhead no permite mutar el processNodeId de un row existente).
- `wrongSfp` queda como **flag**, no se resuelve. Requeriría fetchear el catálogo de specFieldParams del SpecField para encontrar el sfp correcto por nombre; queda como mejora futura (volver a re-correr bulk-upload limpio es alternativa válida).

**Multicliente + QuoteIBMS:**
La resolución es **obligatoria** en MVP porque los CSVs de bulk-upload mezclan clientes (un solo CSV puede traer PNs de múltiples clientes). El index `customerUpper|pnUpper` lo aísla; QuoteIBMS dedupea los homónimos legítimos (mismo cliente + mismo PN, distintos quotes). La info `ambiguousByQuote` se loguea pero no bloquea el flujo.

**Wiring:**
- `remote/scripts/spec-migrator.js:2114` — header del validator a `0.5.0`.
- `dupRenderFilterPanel` — file picker púrpura punteado + handler `change` que llama `dupRunScanFromCsv`.
- `dupCsvParseCSV`, `dupCsvParseRows`, `dupCsvResolvePnIds`, `dupRunScanFromCsv`, `dupCsvClassifyPN`, `dupRenderCsvResults`, `dupUpdateCsvFooter`, `dupRunApplyCsv` — bloque nuevo ~450 líneas antes del `return { run, ... }`.
- No requiere cambios en `extension/background.js` ni en `config.json` más allá del bump.

**Lecciones:**
- **Decidir el wanted requiere intención externa.** El scan global solo puede adivinar (default = mayor id). El CSV es la fuente de verdad para los PNs que ya cargaste; usarlo evita que el operador tenga que tomar 50 decisiones manuales en la tabla.
- **`customInputs` viene como string o como objeto.** Depende del query y del schema. Parseo defensivo con try/catch es obligatorio cuando lo lees vía `AllPartNumbers` (lo trae como string serializado).
- **Multi-cliente NO es opcional para CSVs reales de bulk-upload.** Asumir 1 cliente por CSV rompe en producción — los archivos generados por el wizard mezclan clientes desde el primer día.
- **Wrap-up combinado en 1 mutation por PN > 2 mutations separadas.** STEP 6b de 1.4.38 ya demostró que `SavePartNumber` acepta `paramsToApply + partNumberSpecFieldParamsToArchive` en la misma call sin race conditions internas. Replicar el shape exacto evita inventar.

**Plan de validación pendiente:**
- [ ] Probar con un CSV real chico (5-10 PNs de 1 solo cliente) y verificar resolution, classify y apply contra Steelhead UI.
- [ ] Probar con CSV multi-cliente y verificar dedup por QuoteIBMS en al menos 1 PN con homónimos.
- [ ] Generar caso `wrongSfp` artificial (PN con sfpName que no matchee el CSV) y verificar que queda como flag, no como apply.
- [ ] Re-correr scan global (modo 0.4.x) sobre los mismos PNs después del apply y confirmar 0 duplicados.

---

# `validate-duplicate-params` 0.5.1 (2026-05-25, bump config 1.4.40) — Fix OO: customer con dirección fiscal

**Síntoma:** primer test del modo CSV reportó `4270 unresolved. Primeros: BRAININ DE MEXICO — Dirección Fiscal, — Av. San Luis Tlatilc|50416-1 (no encontrado)`. **100% de los PNs unresolved** → problema sistémico de lookup, no de datos.

**Root cause:** el CSV V10 trae el cliente concatenado con la dirección fiscal (`BRAININ DE MEXICO — Dirección Fiscal, — Av. San Luis Tlatilc`), pero `customerByCustomerId.name` del server es solo el nombre base (`BRAININ DE MEXICO`). Mi lookup hacía `customer.trim().toUpperCase()` literal en ambos lados → cero matches.

**Por qué no lo cacé antes:** asumí que el customer en el CSV iba a venir "limpio" porque mi mental model decía "el CSV viene de un export y el campo cliente debería ser canónico". Si hubiera mirado **1 row real del CSV** antes de codear (no la spec abstracta), el problema se ve en 5 segundos.

**Fix:** replicar la misma fórmula canónica que ya usa `bulk-upload.js:1620`:

```js
const dupCsvNormCustomer = (s) =>
  (s || '').split(/\s*[—–]\s*|\s+[-]\s+/)[0].trim().toUpperCase();
```

Split por:
- `\s*[—–]\s*` — em-dash (U+2014) o en-dash (U+2013) opcionalmente rodeado de espacios.
- `\s+[-]\s+` — guion ASCII solo si tiene espacio a ambos lados (para no romper PNs como `50416-1`).

Se aplica **a ambos lados** del lookup: tanto al `customerByCustomerId.name` del server (defensa por si server también tiene clientes con sufijo) como al `cp.customer` del CSV.

**Wiring:**
- `remote/scripts/spec-migrator.js:3027-3050` — `dupCsvNormCustomer` declarada dentro de `dupCsvResolvePnIds` (scope local); index del server y key de búsqueda usan la misma función.
- Header del action: `0.5.0` → `0.5.1`.
- `remote/config.json`: `1.4.39` → `1.4.40`.

**Lecciones:**
- **Mirar 1 row real del CSV antes de codear el parser.** Es 30 segundos vs 1 hora de debug + redeploy. Internalizar: para cualquier parser de archivo del usuario, **abrir el archivo** (o pedirle las primeras 3 filas) antes de escribir el primer split/regex.
- **Reutilizar normalizadores existentes en lugar de re-inventar.** bulk-upload ya tenía la fórmula correcta porque se topó con este mismo problema antes. Un `grep customer.*split` habría llevado a la línea exacta sin pasar por el bug. (Lo hice DESPUÉS de ver el síntoma — debió ser ANTES de escribir mi primer lookup.)
- **100% failure = systemic, no de datos.** Si el primer test dice "0 de 4270 resueltos", el bug NO es de datos malos en el CSV — es del mapping. Cuando ese ratio sea < 50% sí sería razonable culpar a los datos; cuando es 0% siempre es código.

---

# `validate-duplicate-params` 0.5.2 (2026-05-26, bump config 1.4.41) — Memory hardening

**Síntoma:** después del Fix OO, el modo CSV resolvió bien los PNs pero **la pestaña crasheó por memoria** antes de terminar el scan completo (~4270 PNs). El validador retenía estructuras grandes que no debía.

**Root cause (3 leaks acumulados):**

1. **`AllPartNumbers` full nodes.** El pre-fetch global empujaba el nodo completo a `allNodes[]`, incluyendo `customInputs` como string JSON serializado de 5-20 KB por PN. Con decenas de miles de PNs activos en server, eso son fácil 100-500 MB retenidos solo en el array, repetidos vía el `Map` index.
2. **`GetPartNumber` detail completo retenido por PN.** Cada `item.detail` guardaba el response entero (specs, params, dimensions, locations, predictives, history) — típicamente 50-500 KB por PN. Para PNs con issues, eso vive en `dupState.csvItems` hasta cerrar el panel.
3. **`dupClosePanel` no liberaba `csvItems`/`groups`/`decisions`.** Reabrir el panel sin un page reload acumulaba el estado del run anterior encima del nuevo.

**Fix — 5 cambios de slim/cleanup:**

| # | Dónde | Cambio | Ganancia |
|---|---|---|---|
| 1 | `dupCsvResolvePnIds` pre-fetch | Por cada nodo del response, parsear `customInputs` UNA VEZ in-place y empujar solo `{ id, name, customerName, quoteIBMS }` al array. El response de la página queda fuera de scope al siguiente loop iteration → GC. | De ~5-20 KB/nodo a ~200 bytes (~100×). |
| 2 | `dupCsvResolvePnIds` cleanup post-resolve | `index.clear()` y `liteNodes.length = 0` antes del return. `resolved` retiene solo los pnNode lite usados. | Libera el ~99% restante de los nodos no resueltos + el Map. |
| 3 | `dupCsvClassifyPN` return shape | En lugar de `{ ..., detail }` retornar `{ ..., savePnSeed }` con solo los 9 campos que SavePartNumber consume (`name`, `customerId`, `defaultProcessNodeId`, `inputSchemaId`, `customInputs`, `geometryTypeId`, `partNumberGroupId`, `descriptionMarkdown`, `customerFacingNotes`). | De ~50-500 KB/item a ~1-2 KB (~99% reducción). |
| 4 | `dupRunScanFromCsv` post-populate | `resolution.resolved.length = 0` después de poblar `dupState.csvItems`. | Libera los pnNode lite del `resolved`; el GC los recoge al salir del scope de la función. |
| 5 | `dupClosePanel` cleanup | Limpiar `csvItems`/`csvSelections`/`csvUnresolved`/`csvFetchErrors`/`csvFileName`/`groups`/`decisions` al cerrar el panel. | Evita acumulación entre runs. |

**Wiring:**
- `remote/scripts/spec-migrator.js` — los 5 puntos arriba con comentarios `// 0.5.2 mem:` para trazabilidad.
- Header del action: `0.5.1` → `0.5.2`.
- `remote/config.json`: `1.4.40` → `1.4.41`.

**Cambio API interno (breaking dentro del scope del action):**
- `item.detail` → `item.savePnSeed`. Solo lo consumía `dupRunApplyCsv:3531`, ya migrado.
- `item.customer` ahora prefiere `pnNode.customerName` (campo lite) sobre el `customerByCustomerId.name` que tenía el nodo completo.

**Lecciones (para anotar como pendiente global #113):**
- **Slim responses GraphQL en pre-fetch, no en el consumer.** Si el response trae 50 campos y el código solo usa 4, no retengas los 50. Extrae los 4 al momento de leer la página y deja que el response salga de scope.
- **Parse JSON serializado UNA VEZ, no por cada lookup.** `customInputs` venía como string en cada nodo y mi código original lo parseaba en cada filter de candidates ambiguos. Parsearlo en el pre-fetch y guardar solo el QuoteIBMS extraído evita N parses redundantes Y reduce el peso del nodo.
- **Liberar Maps/arrays intermedios explícitamente.** `Map.clear()` y `array.length = 0` ayudan al GC antes de que la función retorne, especialmente útil cuando el caller va a hacer más trabajo pesado después (como render de 4270 filas + apply).
- **Cleanup en closePanel = parte del contrato del módulo.** Cualquier estado pesado del módulo debe vivir en algo que el closePanel pueda limpiar. Esto es análogo a un destructor — no lo olvides.
- **Seed pattern para mutations futuras.** Si necesitas el response solo para construir un input de mutation N pasos después, extrae el seed mínimo al momento del fetch en lugar de retener el response completo. Patrón replicable en bulk-upload, spec-params-bulk, portal-importer.

**Plan de validación pendiente:**
- [ ] Probar nuevamente con el CSV de 4270 PNs (el que crasheó). Debe completar sin crash.
- [ ] Medir DevTools → Performance → Memory antes y después del scan para confirmar el delta (esperado: pico de 100-500 MB → 5-20 MB).
- [ ] Confirmar que apply (SavePartNumber por PN seleccionado) sigue funcionando con el seed slim en lugar del detail completo.
- [ ] Cerrar y reabrir el panel: confirmar que el segundo run empieza con dupState limpio (no acumula `csvItems` del primero).

---

# `validate-duplicate-params` 0.5.3 (2026-05-26, bump config 1.4.42) — Host cleanup (Datadog + Apollo)

**Síntoma:** después de 0.5.2 (slim de estructuras propias) el applet seguía botando con CSVs grandes. El leak no era nuestro; era **lateral del SPA host de Steelhead**.

**Root cause — 2 fuentes laterales que NO estaba apagando:**

1. **Datadog RUM session replay** sigue activo y graba CADA request/response/DOM mutation que disparamos. En un scan de 4270 `GetPartNumber` + paginado `AllPartNumbers`, el ring buffer del SDK crece sin tope hasta OOM o hasta que el flush a `browser-intake-ddog-gov.com` falle por throttling. bulk-upload 1.4.20 ya documentó este patrón con `memory snapshot 3.5× growth`.
2. **Apollo Client `InMemoryCache`** del SPA host normaliza CADA response GraphQL por `__typename + id`. Cada PartNumber/SpecField/SpecFieldParam que tocamos se queda en el cache aunque no lo volvamos a leer. 4270 PNs × ~10-20 entities por PN = 40-80K entries normalizadas retenidas hasta el reload de la tab.

**Fix — copy del patrón canónico de bulk-upload 1.4.20+:**

- `dupStopHostJobs()` — apaga `DD_RUM`/`datadogRum`/`__DD_RUM__` (`stopSessionReplayRecording`, `stopSession`, `setTrackingConsent('not-granted')`), monkey-patchea `fetch`, `sendBeacon` y `XMLHttpRequest` para abortar requests a `browser-intake-ddog-gov.com`/`datadoghq.com`. Latch global `window.__sa_dd_stopped` cross-applet: si bulk-upload ya lo seteó en esta tab, este call entra al early-return y solo drena Apollo cache silenciosamente.
- `dupApolloCacheDrain()` — busca el cliente Apollo en `window.__APOLLO_CLIENT__`/`window.apolloClient`/`window.__APOLLO__.client` y llama `clearStore()` o `cache.reset()`. Defensa total (try/catch ancha) porque el cliente puede no estar expuesto en el build de prod.
- Se llama:
  - **1×** al inicio de `dupRunScanFromCsv` (antes del primer fetch).
  - **Cada 50 PNs** dentro del progreso del pool `GetPartNumber` (drain silencioso del cache).
- Además: `detail = null` después de `dupCsvClassifyPN` para que la closure del worker no retenga la referencia in-flight (multiplicado × concurrency=6).

**Decisión de arquitectura:**
La función está **copiada inline** en spec-migrator. El refactor correcto es extraerla a `remote/scripts/_steelhead-host-cleanup.js` y que tanto bulk-upload como spec-migrator (y las demás applets que vayan a hacer cargas masivas) la consuman desde ahí. Se queda como **task #113** del refactor global porque requiere tocar `extension/background.js` para inyectar el helper antes de cada applet — superficie más grande de lo justificado para el fix-now.

**Cambios:**
- `remote/scripts/spec-migrator.js:2159-2240` — `dupApolloCacheDrain` + `dupStopHostJobs` (copia inline del patrón).
- `dupRunScanFromCsv:3187` — llamada inicial.
- Pool `GetPartNumber` — drain cada 50 PNs + `detail = null` al final del worker.
- Header del action: `0.5.2` → `0.5.3`.
- `remote/config.json`: `1.4.41` → `1.4.42`.

**Lecciones (extender #113):**
- **Memoria "propia" vs memoria "del host" son ejes distintos.** Slim estructuras propias (0.5.2) ataca lo nuestro; stop Datadog + Apollo drain (0.5.3) ataca lo lateral. Las dos hay que aplicarlas a cualquier applet que haga >1000 queries en una sesión.
- **Latch global cross-applet es la unidad correcta.** `window.__sa_dd_stopped` y `window.__sa_fetch_patched` viven a nivel tab. Si bulk-upload ya patcheó, spec-migrator entra al early-return y no duplica monkey-patches. Esto solo funciona si TODAS las applets usan el mismo nombre de latch.
- **`AllPartNumbers` paginado y `GetPartNumber` masivo son los firsts a auditar en cada applet.** Cualquier query con N rounds = N entries en Apollo cache. Drain periódico es obligatorio.
- **El idea correcto (TODO #113):** extraer a `_steelhead-host-cleanup.js` con un solo export `installHostCleanup({ drainEveryN })` para que cada applet lo invoque una vez y no haya copy-paste drift entre bulk-upload, spec-migrator, etc.

**Plan de validación pendiente:**
- [ ] Probar el CSV de 4270 PNs en tab fresca (sin bulk-upload previo en la sesión): debe completar el scan sin crash.
- [ ] Confirmar en console del browser que aparece `[SPM-dup] Datadog: stopSessionReplay …` solo UNA vez (latch idempotente).
- [ ] Probar el CSV después de un run de bulk-upload en la misma tab: el log Datadog NO debe aparecer (entró al early-return); el Apollo drain sí debe seguir.
- [ ] Comparar heap snapshot pre vs post scan: las entries `Station`/`WorkboardsConnection`/`PartNumber__typename` no deben crecer monotónicamente.

---

# `validate-duplicate-params` 0.5.4 (2026-05-26, bump config 1.4.43) — Fix preferNull en duplicados + wrongSfp ruidoso por hermanos del Spec

**Síntoma reportado durante validación 0.5.3 con CSV real:**

Ejemplo PN 50416-1 (BRAININ DE MEXICO, Q=3879), Spec **RC Ni (Níquel)**:

- **Espesor** (2 rows en server, ambos sfp `"10-13 µm"` — uno con processNode T109, otro NULL). CSV pide `"10-13 µm"`.
  - Resultado 0.5.3: `archive 2 + insert NULL` ← INCORRECTO (archivaba el row NULL existente y reinsertaba un nuevo NULL).
  - Esperado: `archive 1` (solo el row con processNode); el NULL ya existe.
- **Adherencia / Aspecto Visual / Primeras Piezas / Instrumento de Medición** (BOOLEAN/single-option, sfp default).
  - Resultado 0.5.3: `CSV pide "10-13 µm" → ⚠ wrongSfp` × 4 ← FALSO. El CSV nunca pretendió tocar esos SpecFields; el `wrongSfp: 4` inflaba el contador y mostraba ruido en preview.

**Root cause — 2 bugs distintos en `dupCsvClassifyPN` (spec-migrator.js:3295-3406, ahora 3295-3458):**

**Bug #1 — `.find()` no preferenciaba el row null entre matches por sfpName.**
La línea original:
```js
wanted = g.rows.find(r => (r.sfpName || '').trim().toLowerCase() === csvLow) || null;
```
Cuando había 2 rows con el mismo sfpName (uno con processNode, otro NULL), `.find()` retornaba el primero según orden del response (típicamente el con processNode). Luego:
```js
for (const r of g.rows) {
  if (r.rowId === wanted.rowId) continue;
  toArchive.push(r);   // ← archiva el row NULL "como perdedor"
}
if (wanted.processNodeId) {
  toArchive.push(wanted);                                  // archiva el row con processNode
  wantedNullSfp = { sfpId: wanted.sfpId, ... };             // reinserta un NULL nuevo idéntico
  status = 'processNodeRewrite';
}
```
→ Acción: `archive [NULL viejo, processNode]` + insert NULL nuevo. El NULL deseado se destruye y se recrea, doblando el trabajo y el riesgo.

**Bug #2 — `csvSpecMap` indexa por Spec pero el loop itera por SpecField.**
El CSV V10 trae specs como `"NombreSpec | ParamValue"` en columnas AH(33)/AJ(35) — granularidad **Spec**, no SpecField. bulk-upload solo especifica param para el SpecField que tiene múltiples opciones (típicamente Espesor); los hermanos del Spec (BOOLEAN, single-option) son implícitos. El loop original:
```js
for (const [sfId, g] of liveBySpecField) {
  const specKey = (g.specName || '').trim().toLowerCase();   // ← match por Spec
  const cs = csvSpecMap.get(specKey);
  if (!cs) continue;
  const csvParam = (cs.param || '').trim();                  // todos heredan "10-13 µm"
  ...
  if (!wanted) status = 'wrongSfp';
}
```
Todos los SpecFields del Spec "RC Ni (Níquel)" heredaban el mismo csvParam `"10-13 µm"`. Adherencia es BOOLEAN ("Sí o No"), no matcheaba → `wrongSfp` falso × N hermanos. Costo: ruido visual + trabajo extra cuando el aplicador filtra por `wrongSfp`.

**Fix — refactor de `dupCsvClassifyPN`:**

1. **`liveBySpec`** = nuevo Map agrupando SpecFields del live por su Spec padre.
2. **Loop principal por entries del CSV** (no por SpecField del live).
3. **Identificación de target dentro del Spec**: por cada `cs`, encontrar el único SpecField del Spec cuyo catalog vivo (sfpNames) contenga el csvParam. Ese es el target.
   - Si **ninguno** contiene el csvParam → `wrongSfp` REAL, reportado **una sola vez por Spec** (no por cada hermano).
   - Si **uno** contiene el csvParam → ese es target; los demás SpecFields del Spec se procesan como hermanos con `effParam=''`.
4. **Selección de wanted** (Bug #1 fix): entre matches por sfpName, preferir el row con `!processNodeId`:
   ```js
   wanted = matches.find(r => !r.processNodeId) || matches[0] || null;
   ```
5. **Hermanos del Spec** (Bug #2 fix): se validan con `effParam=''`:
   - 1 row vivo → ese es wanted (caso default).
   - 2+ rows con sfpName idéntico (BOOLEAN duplicado por processNode) → preferir NULL.
   - 2+ rows con sfpNames distintos sin param explícito → **sin opinión sólida, no se reporta** (vs antes que entraba a `wrongSfp` ruidoso).

**Trace del caso PN 50416-1 post-fix:**

| SpecField | Rows vivos | Es target? | Acción nueva |
|---|---|---|---|
| Espesor | A "10-13 µm" + T109; B "10-13 µm" + null | Sí | `wanted=B`, toArchive=[A], `duplicateRemove` (1 archive, sin insert) |
| Adherencia (1 row null) | "Sí o No" null | No | `wanted=row`, status='ok' → no reportado |
| Adherencia (2 rows dup) | "Sí o No"+T109, "Sí o No"+null | No | sfpNames size=1 → wanted=null, archive [T109], `duplicateRemove` |
| Aspecto Visual / Primeras Piezas / Instrumento | similar | No | igual a Adherencia |

Eliminados los 4 `wrongSfp` falsos del caso original. Para Espesor, la acción pasa de `archive 2 + insert NULL` a `archive 1` (el correcto).

**Cambios:**

- `remote/scripts/spec-migrator.js:3293-3458` — refactor completo de `dupCsvClassifyPN`. Nuevo `liveBySpec` Map. Loop principal por `csvPart.specs` (no por SpecField). Resolución de `targetSfId` por catalog match. PreferNULL en `wanted`. Hermanos sin opinión sólida ya no se reportan.
- Header del action: `0.5.3` → `0.5.4`.
- `remote/config.json`: `1.4.42` → `1.4.43`.

**Lecciones:**

- **`.find()` con criterio incompleto = bug latente.** Cualquier vez que filtres rows del modelo "1 alive null por SpecField", la regla canónica es **preferir el null** explícitamente. Hay que checar otros validators (audit-incomplete-pns, dupAutoWinner) con la misma regla.
- **CSV Spec vs Live SpecField son granularidades distintas.** El CSV V10 viene en "Spec | param" y el modelo de Steelhead tiene Spec → SpecField → SpecFieldParam. Cualquier matcher que cruce esos niveles debe **resolver el target en una pasada** y validar los hermanos con criterios distintos, no heredar ciegamente el param.
- **`wrongSfp` debe ser real, no ruido.** Cuando el counter dice `wrongSfp: 4` debe significar "el CSV pide 4 cosas imposibles", no "4 SpecFields ajenos heredaron mal el param del CSV". Inflar el counter hace que el operador pierda confianza en el preview.
- **Status `duplicateRemove` no inserta NULL.** Ya era así desde 0.5.0 (línea 3589: `if (i.wantedNullSfp) paramsToApply.push(...)`), pero el bug #1 lo evitaba al forzar `processNodeRewrite`. El fix simplemente devuelve el control a la rama correcta.

**Plan de validación pendiente:**

- [ ] Re-correr el mismo CSV que produjo el caso 50416-1. En el preview, debe aparecer solo Espesor con `duplicateRemove: archive 1` y nada de wrongSfp ruidoso.
- [ ] Confirmar que el counter de `wrongSfp` baja drásticamente (los wrongSfp reportados ahora deben ser casos reales: csvParam que no existe en ningún SpecField del Spec).
- [ ] Comparar el preview total: el número de `archives` debe bajar (no más doble-archive del row null correcto) y el número de `inserts NULL` también (no más insert redundante).
- [ ] Aplicar a un PN de prueba y verificar en UI Steelhead que el row null sigue intacto (no fue archivado y reemplazado).

**Pendientes derivados:**

- Auditar `dupComputeAutoWinner` (modo no-CSV) por la misma regla preferNull entre matches con sfpName igual.
- Si en validación encuentran que hermanos del Spec con `csvParam` heredado SÍ tenían que limpiarse (caso no contemplado): re-evaluar la condición `if (!effParam && sfpNames.size !== 1)` que hoy queda en "sin opinión".
