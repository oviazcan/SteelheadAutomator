# `bulk-upload` — bitácora completa

Versiones documentadas: 1.0.0 → 1.4.28. Para deploy y reglas generales, ver `../../CLAUDE.md`.

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

**Bug 1 — `isNonFinishLabel` case+space-sensitive.** Línea 4164 usaba `nonFinishList.some(nf => nf.toUpperCase() === String(name).toUpperCase())` que NO trimea espacios. Si Steelhead devolvía `"SRG "` (con trailing space) o `"srg"` (lowercase, edge no observado pero posible), las 7 plantas (`SCM/SMY/SQR/SQ2/SRG/STX/SXC`) escapaban al filtro y contaban como acabados → "Decapado + STX" se comparaba contra "Decapado" del CSV y fallaba.

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

