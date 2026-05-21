# `process-deep-audit` — bitácora completa

Versiones documentadas: 0.7.0 → 0.8.0. Para deploy y reglas generales, ver `../../CLAUDE.md`. Para arquitectura de procesos, ver `../processes-architecture.md`.

## 0.7.0: bitácora del MVP (2026-05-15, deploy a producción `b74d116`)

Applet hermano de `process-canon`, **read-only**, que evalúa 4 reglas (R1-R4) sobre todos los procesos `PROCESS` del dominio y genera plantilla XLSX con columnas editables (`*_NUEVO`) para futura Fase 2 de carga masiva. Lecciones clave del ciclo MVP:

- **Refactor a módulo compartido `process-shared.js`.** El primer instinto fue extender `process-canon.js` con la auditoría; mala idea porque la lógica de mutación de árboles vive ahí y mezclarla con auditoría read-only viola separación de responsabilidades. Patrón aplicado: tercer script `process-shared.js` con catálogo + queries + helpers de identificación (LINE_MAPPING, GLOBALS, TAG_PATTERNS, NAME_FILTERS, AUX_SUFFIXES, EPOXY_SUFFIXES, PREP_CODES, listoPPName, isSatelliteCode, getLineCode, detectLineSections, extractFinishSuffixes, loadAllNodes, loadScannerNodes, loadSharedByLine, getProcessTree, getProcessDetail, getTreatmentDetail, getTreatmentTimes, getProcessNodeParents, intervalToMinutes, finishProductMap, satelliteOverrides, auditConcurrency). Tanto `process-canon` como `process-deep-audit` lo consumen vía `const PS = window.ProcessShared`. **Orden de carga importa**: en `config.apps.process-canon.scripts` debe ir `api → shared → canon → deep-audit`; en `background.js` el guard `if (!window.ProcessShared) return shim` evita crash si se carga fuera de orden.
- **Refactor surgical, no big-bang.** Al delgazar `process-canon.js` para que use PS, el primer intento `Edit` borró el bloque viejo de constantes pero dejó **160 líneas duplicadas de LINE_MAPPING** + EPOXY/AUX/PREP_CODES sin sustituir, creando errores `Identifier '...' has already been declared`. Lección: cuando borres un bloque grande con `Edit`, **verifica que `old_string` cubra el closer del bloque** (`};`/`}`), no solo el primer item interno. Si dudas, `sed -i '<line_start>,<line_end>d'` con line numbers reales es más confiable que un `Edit` de 200 líneas. Cierre: `sed` para borrar líneas 62-222 y 118-135, luego `node -c` para validar sintaxis antes de continuar.
- **Aliasar vs delegar.** Para constantes (`const LINE_MAPPING = PS.LINE_MAPPING`) basta con aliasar. Para funciones con state local (`loadAllNodes` mutaba `_nodesByName`, `_sharedIds`, etc.), aliasar a `PS.loadAllNodes` requería tirar todo el state y cambiar lookups. Decisión pragmática del MVP: dejar los loaders y lookups locales de `process-canon` intactos (cargarían el catálogo dos veces, pero sin bugs); centralizar **constantes** (que son el grueso del LOC) y dejar que `process-deep-audit` use PS desde cero. La duplicación funcional es deuda técnica reconocida, no bug.
- **XLSX library injection.** `process-deep-audit` usa SheetJS para construir las 6 hojas. El patrón estándar (`scripts/lib/xlsx.full.min.js`) requiere inyección **antes** de los scripts del app porque process-deep-audit toca `window.XLSX` al construir el blob. En `background.js` el case `run-process-deep-audit` hace `fetchScriptCode → executeScript(if !window.XLSX) → injectAppScripts(process-canon)` en ese orden. Reusable: cualquier applet futuro que produzca XLSX debe seguir este patrón en lugar de tratar de `import()` dinámicamente (no funciona en MAIN world con MV3).
- **Captura del JSON del scan ANTES de escribir queries.** Antes del MVP se sacó `scan_results_2026-05-15_182824.json` con el flujo "Edit Times" del UI nativo. Confirmó 6 hashes nuevos (`GetTreatment`, `AllTreatments`, `CreateEditTreatmentTimesDialogQuery`, `StationsByTreatmentId`, `GetProcessNodeParents`, `CreateEditProcessDialogQuery`) y los shapes de respuesta (`Treatment → StationTreatment(stationId, treatmentTime:null) → TreatmentTime(cycleTime, totalTime, timeType)`). Sin el scan previo habríamos adivinado los hashes y el shape (riesgo de gaps como los de `invoice-auto-regen` 0.5.36-37). Verificación rápida: `jq '.scanResults.GetTreatment | {hash, responseSamples: (.responseSamples|length), httpStatus: .lastHttpStatus}'`.
- **Catálogo híbrido de satélites.** R3 requiere identificar todos los satélites (T100, T200, T300, T400, T500 y nodos con sufijos `FIB`/`ANT`/`HOR`/`LIM`/`VIB` etc.). Estrategia: (1) regex `SATELLITE_REGEX = /^[TM]\d+00\s/i` sobre nombres + (2) sufijos auxiliares + (3) override en config (`steelhead.domain.processAudit.satelliteOverrides.include/exclude`). El override permite afinar sin redeploy de scripts (solo bump de `version` y push de `config.json`). Generalizable: **cualquier catálogo derivado de regex que se preste a falsos positivos/negativos debe tener un canal de override por config para no requerir code change**.
- **`finishProductMap` extensible en config.** R4-c valida coherencia entre sufijos del nombre del proceso (`(EST)`, `(NIQ)`, `(CRO)`, etc.) y tokens del nombre del producto (`ESTAÑADO`, `NIQUELADO`, `CROMADO`, etc.). El mapeo vive en `config.steelhead.domain.processAudit.finishProductMap` para que QA/Producción pueda extender sin tocar código. Tokens case-insensitive y strippeo de acentos (`ESTAÑADO` ≡ `estanado`). 9 sufijos arrancando: EST, NIQ, CRO, PLA, COB, ANT, FIB, HOR, ZIN.
- **Pool concurrente + cancellation token.** El audit toca ~300+ procesos. Pool de 5 (`steelhead.domain.processAudit.concurrency`) con semáforo + cancellation token (`runId` monotónico + `isStale()`/`bailIfStale()`), mismo patrón de `invoice-autofill` 0.5.32. Importante: **TODAS las funciones async** del orchestrator (incluyendo helpers de retry como `withRetry`) deben aceptar `myRunId` o tener acceso a `isStale()`, sino el botón "Detener" no responde hasta que termine el lote actual. `retryDelaysMs: [0, 1000, 2000]` por proceso; tras 3 fallos → fila con `EstadoGlobal: ERROR` (no abortar la corrida).
- **Output XLSX con columnas `*_NUEVO` editables.** Las hojas R2/R3/R4 incluyen columnas vacías (`CycleTime_min_NUEVO`, `TotalTime_min_NUEVO`, `TimeType_NUEVO`, `LeadTime_horas_NUEVO`, `ProductName_NUEVO`) que el operador rellena en Excel. Fase 2 (no incluida en este MVP) será un applet hermano que **lee** el XLSX editado y hace las mutaciones de carga masiva. Diseño separado a propósito: read-only es seguro de probar en producción; write-back requiere su propio ciclo de validación.
- **Plan de prueba post-deploy.** Validar 5 procesos curados: 1 esperado OK en todas las reglas, 1 con R1 conocido (Listo no-Scanner), 1 con R2-c (Listo sin tiempos), 1 satélite válido (HOR o FIB con tiempos), 1 sin lead time o sin producto. La cancelación a mitad de corrida debe dejar sin requests colgados, y un 502 individual debe ir a `EstadoGlobal: ERROR` sin abortar.

**Files tocados (deploy `b74d116`):**
- NUEVO `remote/scripts/process-shared.js` (~865 líneas)
- NUEVO `remote/scripts/process-deep-audit.js` (~860 líneas)
- MODIFICADO `remote/scripts/process-canon.js` (–218 líneas, –10%; constantes centralizadas en PS)
- MODIFICADO `remote/config.json` (6 hashes + satelliteOverrides + finishProductMap + concurrency + action `run-process-deep-audit`; bump 0.6.24 → 0.7.0)
- MODIFICADO `extension/background.js` (globals `ProcessShared`/`ProcessDeepAudit` + case `run-process-deep-audit` con XLSX injection)
- MODIFICADO `docs/processes-architecture.md` (nueva sección 10: "Treatments, stations y tiempos")

**Pendientes derivados (no bloqueantes para MVP):**
- Refactorizar loaders/lookups de `process-canon` para usar `PS.getCatalog()` y eliminar la doble carga del catálogo (deuda técnica conocida; el applet funciona correcto pero hace 2× requests).
- Fase 2: applet hermano que lee el XLSX editado y hace mutaciones bulk de `TreatmentTime` y `UpdateProcessNode` (lead time/producto).
- Pinear hashes SHA-256 de los nuevos scripts en `config.json` (item 1 del audit pre-producción).

## Hotfix 0.7.1 (2026-05-15, deploy `7cf027e`): STEP_SHIPPING_READY válido en R1
Primera ronda de prod test reveló que R1 reportaba como inválidos los nodos "Listo" del flujo de embarques (tipo `STEP_SHIPPING_READY`). **Ese tipo es válido por diseño** — es el especial para sub-procesos de embarque, no debe reportarse como problema. Fix: agregar `STEP_SHIPPING_READY` al `validTypes` Set de `evaluateR1` junto con `SCANNER_NODE` y `STAGING`. Label `TipoEsperado` actualizado a `"SCANNER_NODE / STAGING / STEP_SHIPPING_READY"`. Diff de 3 líneas funcionales + comentario explicativo en la función.

**Lección generalizable:** las whitelists de tipos válidos por dominio (no solo R1 — aplica a cualquier validador) deben construirse desde la observación del catálogo real, no desde la suposición del diseño. Cuando un validador empieza a reportar falsos positivos en su primera corrida, **el fix es ampliar la whitelist** si el tipo flagged es legítimo, no relajar el matcher. Documentar el "por qué válido" inline en el código (no solo en commit) para que el siguiente que lea evaluateR1 entienda el dominio sin tener que ir al historial git.

**Files tocados:**
- `remote/scripts/process-deep-audit.js` — `validTypes` Set + label `TipoEsperado` + comentario inline + VERSION
- `remote/config.json` — bump 0.7.0 → 0.7.1
- `docs/processes-architecture.md` — sección 10.1 R1 actualizada con nota de validez de STEP_SHIPPING_READY

**Estado de deploy:**
- `main`: commits `8cc4b0f` (bitácora 0.7.0) y `a10efca` (fix 0.7.1) **pendientes de push** (auto-mode bloquea push a default branch sin autorización explícita). El usuario debe correr `git push origin main` manualmente para sincronizar.
- `gh-pages`: deployed como `7cf027e` y pushed a remote.

## `process-deep-audit` 0.8.0: deploy de Detección de Duplicados (2026-05-18, pushed `7991a7c`/`faecdd3`, validación en prod PENDIENTE)
Implementación completa del plan `docs/superpowers/plans/2026-05-18-process-duplicates.md` (T1-T12 + T14). Agrega 3 firmas de duplicado (D1: nombre normalizado, D2: tren de IDs top-level, D3: tren de nombres top-level) sobre universo unificado (PROCESS principales + satélites + RT + SUB_PROCESS + STEP_SHIPPING). Read-only: 10 hojas XLSX (Leyenda + Resumen + R1-R4 + D1/D2/D3 + Catálogos) con `AccionSugerida_NUEVO` editable para Fase 2 futura. Ejecutado vía subagent-driven-development; T6-T10 pasaron spec+quality review en primera iteración (sin rework).

**Patrón clave: cache compartida entre fases.** `state.treesById: Map<id, {treeRoot, processNodeById}>` se llena durante R1-R4 (en `auditProcess` y `evaluateR3`) y `evaluateD` la consume primero. Solo fetchea `getProcessTree` para los faltantes (típicamente SUB_PROCESS/STEP_SHIPPING/RT que R1-R4 no tocan). Pool separado `processAudit.concurrency.trees` (5) para árboles faltantes y `processAudit.concurrency.parents` (5) para `getProcessNodeParents`. Cancelación parcial soportada: si se aborta a mitad del fetch, D1 emite completo (no depende del árbol), D2/D3 con los árboles disponibles, `state.duplicates.partial=true` → panel marca `[PARCIAL]`, Resumen pone `NotaParcial = "PARCIAL_POR_CANCELACION"`.

**Canónico por id+parents.** `pickCanonical(members, parentsByIdCache)` ordena: (1) más referencias entrantes gana (`getProcessNodeParents` count); (2) empate → id más bajo gana. `AccionSugerida` automática: canónico → `MANTENER`; no-canónico con `refs=0` → `ARCHIVAR`; no-canónico con `refs>0` → `FUSIONAR` (re-apuntar referencias antes de archivar); refs desconocido (502/cancelación) → vacío. `parentsByIdCache` se llena solo para miembros de grupos con `size ≥ 2` (evita gasto en singletons).

**Output XLSX expandido.** `addSheet(name, title, rows, headers)` añade fila de título en A1 con merge (`ws['!merges']`) cubriendo todas las columnas. Headers compartidos en D1/D2/D3 (15 cols incluyendo `EsCanonico`, `RefsEntrantes`, `AccionSugerida_NUEVO`, `Notas`, `EstadoGlobal`, `NotaParcial`). Resumen ahora indexa duplicados por ProcessID con helper `bump`, suma `Duplicados_D1/D2/D3` y agrega bloque de filas extra para nodos que solo aparecen en grupos D (SUB_PROCESS/STEP_SHIPPING/RT que no son universo R1-R4).

**Filtros vía config.** `steelhead.domain.processAudit.duplicates`:
- `enabled: false` salta toda la fase D
- `includeSources: [...]` limita buckets del universo
- `ignoreIds: [int]` excluye IDs específicos
- `ignoreNamePatterns: ["regex"]` excluye por nombre (case-insensitive)

**Lección reforzada: cache cross-fase requiere disciplina de identidad.** El primer instinto fue que `evaluateD` re-fetchara todos los árboles. Mala idea: ya R3 los tiene en memoria como árbol completo expandido. La clave es definir el shape del cache (`{treeRoot, processNodeById}`) en `process-shared.js` y que **TODOS los consumidores** (R3 y `auditProcess` en la fase R1-R4 + `evaluateD` en la fase D) usen exactamente el mismo. Sin esto, terminas con dos caches paralelos por accidente. La cache vive en `state` (no module-level) para que la cancelación de la corrida la libere automáticamente.

**Files tocados (deploy pushed 2026-05-18):**
- MODIFICADO `remote/scripts/process-shared.js` — firmas D1/D2/D3, accessor `duplicatesConfig`, helpers `buildAuditUniverse`, `normName`, `extractTopLevel`
- MODIFICADO `remote/scripts/process-deep-audit.js` — `state.treesById`, `evaluateD`, `pickCanonical`, panel UI con 7 tabs (R1-R4 + D1/D2/D3), `RULE_LABELS`, `addSheet`, `buildLeyendaRows`, Resumen con `Duplicados_D1/D2/D3` + `NotaParcial`, `VERSION = '0.8.0'`
- MODIFICADO `remote/config.json` — bump 0.7.1 → 0.8.0, `lastUpdated: 2026-05-18`, bloque `processAudit.duplicates` (enabled/includeSources/ignoreIds/ignoreNamePatterns), `processAudit.concurrency.trees=5` y `parents=5`
- MODIFICADO `docs/processes-architecture.md` — nueva fila al glosario §9 (0.8.0 deep-audit) + nueva sección 12 "Detección de duplicados (process-deep-audit ≥ v0.8.0)" con 6 subsecciones (12.1 Firmas, 12.2 Canónico con code block de `pickCanonical`, 12.3 Universo y filtros, 12.4 Cache `state.treesById`, 12.5 Cancelación parcial, 12.6 Pendientes)
- MODIFICADO `extension/background.js` — sin cambios funcionales (XLSX injection y orden de scripts ya existía de 0.7.0)

**Estado de deploy (2026-05-18):**
- `main`: `7991a7c` (T14 doc) + `9f5a830` (config bump) + commits T1-T10 — **pushed a remote**.
- `gh-pages`: `faecdd3` (deploy 0.8.0 byte-exact con `remote/`) — **pushed a remote**.

**T13 (validación en prod) PENDIENTE.** El usuario tiene que reanudar en otra sesión: recargar la extensión en Chrome (chrome://extensions → reload) tras esperar ~30-60s del refresh de GitHub Pages, luego correr el applet en producción y validar contra 5 procesos curados:
1. Un proceso esperado OK en todas las reglas (R1-R4 sin hallazgos, no aparece en D1/D2/D3).
2. `SP Embarque en Almacén` — el caso conocido de 7 IDs activos duplicados; debe aparecer en D1 con `Duplicados_D1=7` y un canónico marcado.
3. Un proceso que aparezca en D3 (clones por "Save As..." con mismo tren de nombres top-level pero IDs distintos).
4. Un satélite (HOR/FIB/etc.) válido — debe aparecer en R3 con tiempos OK y, si tiene clones, también en D1/D2/D3 según corresponda.
5. Una corrida cancelada a media fase D — verificar que el panel marca `[PARCIAL]`, Resumen muestra `NotaParcial = "PARCIAL_POR_CANCELACION"` y D1 emite completo aunque D2/D3 estén truncados.

Cosas a chequear durante la validación:
- Que `Duplicados_D1/D2/D3` en Resumen cuadren con las filas de las hojas D.
- Que `EsCanonico=true` en cada grupo apunte al ID con más referencias entrantes (o id más bajo en empate).
- Que `AccionSugerida_NUEVO` venga pre-llenada (MANTENER/ARCHIVAR/FUSIONAR) y editable.
- Que la hoja Leyenda explique R1-R4 + D1-D3 con sigla → descripción → subcaso → estado posible → acción típica.
- Que el título mergeado (A1) muestre nombre del dominio + fecha de la corrida.
- 502 individual en `getProcessTree` o `getProcessNodeParents` debe ir a `EstadoGlobal: ERROR` sin abortar la corrida.

Si la corrida revela algún gap (regex mal calibrado, falso positivo, output XLSX mal formado), abrir nueva sesión con el `scan_results_*.json` de la corrida + screenshot del panel y el XLSX descargado para diagnóstico.

**Pendientes derivados (no bloqueantes):**
- **Fase 2 — applet hermano de write-back.** Leer XLSX editado con `AccionSugerida_NUEVO ∈ {ARCHIVAR, FUSIONAR, MANTENER}` y aplicar mutaciones. Para `FUSIONAR` requiere re-apuntar referencias entrantes al canon antes de archivar (mutation `ArchiveProcessNode` o equivalente — **no investigado aún, requiere capturar el flujo nativo del UI primero**).
- **D4 full-depth.** Si D3 top-level resulta insuficiente en la práctica, recursar firmas. Requiere `flattenTree` enriquecido y costo recursivo controlado.
- **Detección incremental.** Persistir resultado en `chrome.storage.local` para reportar "nuevos grupos vs corrida anterior".
- **Refactor doble-carga del catálogo en `process-canon`.** Ítem ya documentado en bitácora 0.7.0; sigue pendiente.

