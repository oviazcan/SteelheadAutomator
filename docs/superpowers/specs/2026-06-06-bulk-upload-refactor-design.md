# Refactor Bulk Uploader — Diseño

**Fecha:** 2026-06-06
**Applet:** `bulk-upload` (Carga Masiva) — `remote/scripts/bulk-upload.js` (6996 líneas)
**Estado:** Diseño aprobado (verbal). Pendiente revisión del spec antes de plan de implementación.

## 1. Contexto y problema

El applet `bulk-upload` automatiza la carga masiva de números de parte (PN) y cotizaciones
contra Steelhead ERP. Funciona y acumula mucho comportamiento ganado a pulso, pero:

- **Lento / llamadas de más:** el mismo `GetPartNumber` se re-fetchea hasta 4 veces por PN en
  STEPs distintos (6, 6b, 7b, 8); hasta 5 `SavePartNumber` por PN MODIFY; `AddParamsToPartNumber`
  uno-por-uno; `SaveQuoteLines` línea-por-línea; `UpdateQuote` doble secuencial; `buildEquivIndex`
  recalculado 4×.
- **UI confusa:** 4 capas DOM con z-index inconsistente; `showPreview` (overlay full-screen)
  separado del panel lateral; dos sistemas de barra de progreso desincronizados; los pasos a/b/c
  no indican claramente dónde va; dos `window.confirm()` bloqueantes.
- **Monolito:** un solo archivo de 6996 líneas, difícil de testear.
- **Memory hardening inline:** funciona pero no usa el módulo compartido `host-cleanup-shared.js`;
  `makePeriodicDrain` ni se llama.
- **Residuo en localStorage:** `sa_load_history` (revienta por cuota en producción).
- **Bug latente:** `partNumberLocations` siempre se manda `[]` (Skip 8) — si SH aplica REPLACE,
  cada MODIFY borra ubicaciones.

## 2. Objetivos

1. Más rápido y eficiente: eliminar llamadas redundantes, reordenar bloques de trabajo.
2. UI clara: panel anclado a la derecha, expandible; **dos barras** (global + paso actual);
   stepper que indique el paso a/b/c; sin modales que se traslapen.
3. Inteligencia de intención: detectar SOLO_PRECIO / ajuste-de-línea / enriquecimiento / alta y
   retroalimentar en el preview; **fast-path** para SOLO_PRECIO.
4. **No romper** el comportamiento ganado: blank/(seleccione)→preservar, dash→borrar, dato→modificar;
   procesos all-missing→preservar, at-least-one→modal preservar; etiquetas y predictivos como bloque.
5. **No romper** memory hardening (migrar a módulo compartido).
6. Todo por DB (IndexedDB), nada en localStorage.
7. Corregir bugs latentes.

## 3. Decisiones (confirmadas con el usuario)

| Tema | Decisión |
|---|---|
| Estrategia | **Híbrido**: extraer helpers puros + UI a módulos testeables; reordenar pipeline in-place con orquestador delgado. |
| Inteligencia | **Detectar + badge + fast-path** SOLO_PRECIO, con validación estricta de columnas. También clasificar ajuste/enriquecimiento/alta como feedback (sin fast-path). |
| Pruebas de escritura | Crear un NP **"Pruebas Claude"** como sandbox propio; validar end-to-end ahí. |
| UI | **Panel anclado a la derecha**, expandible (preview arriba, progreso con 2 barras abajo, SH visible detrás). |
| precioAnterior | Incluir (cae gratis del seed consolidado). |
| Concurrencia capaA | Arrancar en 3, subir a 8 tras validar. |

## 4. Arquitectura objetivo (híbrido)

```
remote/scripts/
  bulk-upload.js          orquestador + pipeline per-PN          (~3000-3500L)
  bulk-upload-cc.js       ControlCambios (existe; +precioAnterior real)
  bulk-upload-parse.js    PURO: parseCSV, parseRows, COLS, isDash, resolveStr/Num,
                          buildDimensions, detección de columnas + intención  ← node --test
  bulk-upload-classify.js PURO: equivIndex, rankCandidates, classifyOnePN,
                          dedupModifyTargets, buildCompositeKey                ← node --test
  bulk-upload-ui.js       panel derecho expandible, 2 barras, stepper, overlays async, escapeHTML
  host-cleanup-shared.js  memory hardening (se ADOPTA, no inline)
```

Los `*.js` puros no tocan DOM ni API → testeables con `node --test` (precedente: `bulk-upload-cc.js`
con 19 tests). Ahí viven los **golden tests** de los invariantes.

`config.json` → `apps[carga-masiva].scripts` queda:
`["scripts/steelhead-api.js", "scripts/host-cleanup-shared.js", "scripts/bulk-upload-cc.js",
"scripts/bulk-upload-parse.js", "scripts/bulk-upload-classify.js", "scripts/bulk-upload-ui.js",
"scripts/bulk-upload.js", "scripts/catalog-fetcher.js"]`
(host-cleanup ANTES del principal; orden de carga importa).

## 5. Pipeline rediseñado

### 5.1 Cambio clave: worker per-PN consolidado

Hoy el enriquecimiento son 7 fases separadas (6, 6a, 6b, 7, 7b, 8, 8a) y **cada una re-fetchea el
mismo PN**. Se colapsan en **un solo worker por PN** con **un único `GetPartNumber`**, respetando
las restricciones reales de orden:

**Bloque A — Cotización** (solo COTI; orden obligado: la línea referencia el PN activo):
```
crear PNs (capaA en pool 3→8 / capaB serial)
  → sentinels pre-archive
  → CreateQuote
  → SaveManyPartNumberPrices (batch)
  → SaveQuoteLines (batch x cotización)
  → UpdateQuote (1 call: notas ext + int)
```

**Bloque B — Enriquecimiento per-PN** (pool concurrente, independiente por PN):
```
pnWorker(pn):
  GetPartNumber (1×) → seed slim ampliado
  → buildPreserveInput (blank/dash/data + FK-fallback + REPLACE-safe + locations preserve)
  → SavePartNumber enrich (Call A+B consolidados donde se pueda)
  → specs colisionantes (split)
  → params (AddParamsToPartNumber batch x PN)
  → predictivos (cascade; ver nota)
  → racks
  → delete-price / default-price (desde seed, sin re-fetch)
  → archive/unarchive
  finally: seed.delete()
```

Los **órdenes internos críticos se preservan dentro del worker** (predictivos: unarchive→update→archive;
specs: archive-antes-de-reaplicar; split de colisiones).

**Nota predictivos:** validar contra el sandbox si `ChangePredictedInventoryUsagesWithRecipeNodeCascade`
admite por-PN o exige batch global. Si exige batch, esa pieza queda como sub-fase y el resto del worker
no cambia.

### 5.2 Reducción de llamadas

| | Hoy | Refactor |
|---|---|---|
| `GetPartNumber`/PN | ~4 | **1** |
| `SavePartNumber`/PN MODIFY | hasta 5 | **2-3** |
| `AddParamsToPartNumber` | 1 por param | **1 por PN** |
| `SaveQuoteLines` | 1 por línea | **1 por cotización** |
| `UpdateQuote` | 2 secuenciales | **1** |
| `CurrentUserDetails` + `GetPartNumbersInputSchema` | 2 awaits seriales | **1 `Promise.all`** |
| `buildEquivIndex` | 4× | **1×** (init) |
| Peak memoria enrich | O(concurrency) | **O(concurrency)** (se mantiene) |

### 5.3 Memoria del cache consolidado

El `GetPartNumber` consolidado **no guarda el detail completo** (60KB × N = OOM). Guarda un **seed
slim ampliado** (patrón `savePnSeed`): `{id, FK-relacionales resueltos (customerId, processNodeId,
groupId, geometryTypeId), labelIds, dims, customInputs, specIds, specFieldParamIds,
prices[id,amount,isDefault], locationIds, predictivos}`. Como el worker hace **todo lo del PN en una
pasada y borra en `finally`**, el peak sigue siendo **O(concurrency)**, no O(N). Se valida
empíricamente con el mem monitor contra el sandbox antes de subir concurrencia.

## 6. Inteligencia de intención

En `bulk-upload-parse.js`, tras parsear, clasificar la corrida por **columnas con datos** (header scan
de las primeras filas, no toda la tabla):

- **SOLO_PRECIO** → solo columna precio con datos; sin specs/labels/dims/proceso/predictivos; todos los
  PN existen → **badge + fast-path** (omite sentinels, predictivos, params; corre solo precios +
  default). Validación **estricta** de nombres de columna para no omitir enriquecimiento por un CSV mal
  armado.
- **AJUSTE_LÍNEA / ENRIQUECIMIENTO / ALTA** → badge informativo (por corrida y por PN en el preview);
  pipeline completo.
- **Delta de precio:** con `prices` del seed mostrar `precioAnterior → precioNuevo` en el preview y
  pasarlo real a `ControlCambios.Detalle` (resuelve el pendiente `precioAnterior`). Comparar con
  epsilon para floats; si igual, no estampar ControlCambios (evitar ruido).

## 7. UI nueva (`bulk-upload-ui.js`)

- **Panel anclado a la derecha**, un solo árbol DOM, sin overlay full-screen separado; SH visible detrás.
- **Fase preview:** panel ancho con tabla de decisiones + badge de intención.
- **Fase ejecución:** se encoge; muestra **stepper** (Paso 6/10) + **dos barras**: global (avanza por
  paso) y paso-actual (avanza por PN del pool).
- **Confirmaciones async** (procesos unresolved, conflicto de cotización) como overlay **interno** del
  panel — eliminar los `window.confirm()` bloqueantes.
- **`escapeHTML()`** en todo dato de PN/cliente/error interpolado (cierra el XSS de O3).
- Gauge de memoria con lazy-init (no corre contra DOM muerto al re-abrir).

## 8. Invariantes que NO se pueden romper (16)

Antes de tocar el pipeline, escribir **golden tests** en los módulos puros que congelan el
comportamiento actual:

1. **Blank/Dash/Data** tri-estado (proceso, labels, dims, racks, predictivos, specs): vacío/(seleccione)→preservar; `-`→borrar; dato→modificar.
2. **REPLACE-semantics** de arrays en `SavePartNumber` (labelIds, dims, optInOuts, specs, locations): MODIFY sin columna conserva lo existente.
3. **FK-fallback** en 4 escalares: `customerByCustomerId?.id ?? customerId` (+ processNode, group, geometry).
4. **pnSucceeded gating**: STEP 6b/specs/ControlCambios solo si el SavePartNumber principal no lanzó.
5. **existingPnFullCache.delete() en finally** (peak O(concurrency)).
6. **Procesos all-missing→preservar todo / at-least-one→modal preservar**; dash→borra defaultProcessNodeId.
7. **Feature A blank-acabados**: confianza `name+blank-csv-recent` ANTES de `labelsMatchFull`.
8. **runtimeInputSchemaId dinámico** (no hardcodear 3456; leer latestSchema.id en runtime).
9. **ControlCambios** 1 entrada/corrida, solo si hubo cambio real; append no-destructivo; Version de `window.REMOTE_CONFIG.version`.
10. **Resume en IndexedDB** (no localStorage).
11. **Datadog stop ANTES de showPanel**.
12. **capaA paralela / capaB serial** (evita constraint violation en creates colisionantes).
13. **partNumberLocations preserve-on-missing** (Skip 8 — validar y corregir).
14. **Guardrail anti-OOM 88%** dispara una vez.
15. **myRunId cancellation token** propagado a runPool y withRetry.
16. **labelsSet/predictiveSet** se cuentan solo si el valor realmente cambió.

`buildPreserveInput(part, seed, runtimeInputSchemaId)` centraliza TODA la lógica blank/dash/data + FK +
REPLACE-safe en **un solo lugar** (hoy repetida en Call A/B/STEP5/6b).

## 9. Memory hardening — adopción del módulo compartido

- Agregar `host-cleanup-shared.js` al array `scripts` (ANTES de `bulk-upload.js`).
- Reemplazar el bloque inline (L200-350) por `window.SteelheadHostCleanup.*` con **guardia de
  transición** (`if (window.SteelheadHostCleanup) … else inline-fallback`).
- Activar `makePeriodicDrain(50)` en el pool (hoy no se llama).
- Mantener guardrail 88% con su latch único.

## 10. Storage → 100% DB

- Migrar `sa_load_history` de localStorage → IndexedDB (migración one-shot de lo existente).
- Corregir tooltip L2816 y comentarios que dicen "localStorage" cuando ya es IDB.
- Persistir progreso de racks/archive en IDB (resume granular — O7).

## 11. Bugs a corregir

- 🔴 **Skip 8 — `partNumberLocations:[]`**: validar contra sandbox si SH borra ubicaciones; si sí,
  preserve-on-missing desde seed.
- `precioAnterior` real en ControlCambios.
- Jitter en `withRetry` (anti thundering-herd); `AbortController` 30s por llamada API.
- `clearDefaultProcess` flag muerto (limpiar).

## 12. Plan de pruebas (autónomo, no destructivo salvo sandbox)

1. **Golden tests** de módulos puros (`node --test`) — congelan los 16 invariantes.
2. **Validación de shapes** con lecturas reales (`GetPartNumber`/`AllSpecs`/`GetQuote`) vía runner
   Python (`tools/steelhead_probe.py`) usando los hashes de `config.json` + JWT de `steelhead_auth.py`.
   Solo lecturas → no destructivo.
3. **Sandbox "Pruebas Claude"**: crear el NP y validar end-to-end cada caso (blank, dash, dato,
   procesos, labels-bloque, locations, precio, fast-path) leyendo estado antes/después. Mem monitor en
   corridas controladas.
4. **Dry-run de payloads**: armar el payload de cada SavePartNumber y compararlo vs estado actual antes
   de commitear.

## 13. Entrega por fases (cada una verificable y desplegable)

1. **F1** Golden tests + extracción de módulos puros (sin cambio de comportamiento). + `steelhead_probe.py`.
2. **F2** Adopción host-cleanup + storage a IDB + fixes de bugs chicos.
3. **F3** UI nueva (panel derecho, 2 barras, async modals, escapeHTML).
4. **F4** Pipeline consolidado (worker per-PN, 1× GetPartNumber, batches) — el grande, validado vs sandbox.
5. **F5** Inteligencia de intención + fast-path SOLO_PRECIO.

Cada fase: bump `config.version`, deploy a `gh-pages`, verificar byte-exact.

## 14. Riesgos y mitigaciones

| Riesgo | Mitigación |
|---|---|
| `buildPreserveInput` rompe blank/dash/data o FK | Golden tests + sandbox antes de F4. |
| Cache ampliado sube memoria | Seed slim + peak O(concurrency) + mem monitor; subir concurrencia solo tras validar. |
| Fast-path omite enriquecimiento por detección de columnas fallida | Validación estricta + tests de CSVs límite. |
| Batch SaveQuoteLines pierde líneas en error parcial | Error handling por línea. |
| Migración host-cleanup: SteelheadHostCleanup undefined si orden de scripts mal | Guardia `if (window.SteelheadHostCleanup)` + fallback inline durante transición. |
| Colisión de versión en deploy paralelo de config.json | Bump en pasada corta; coordinar. |

## 15. Fuera de alcance (diferido)

- Hoja "Decisiones campo×campo" en el reporte XLSX (observabilidad) — evaluar tras F5.
- Big-bang modular completo (7 módulos) — el híbrido cubre lo testeable sin la reescritura total.
- Integridad de scripts remotos (pin SHA-256) — item de seguridad separado del audit.
