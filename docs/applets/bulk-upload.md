# `bulk-upload` — bitácora completa

Versiones documentadas: 1.0.0 → 1.4.2. Para deploy y reglas generales, ver `../../CLAUDE.md`.

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
- **Blacklist de acabados:** `SMY, STX, SXC, SRG, SCM, SQR, SQ2, NP desconocido, En desarrollo, Muestras, Lote, Obsoleto` se ignoran al construir el composite (etiquetas operativas, no acabados químicos).
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

