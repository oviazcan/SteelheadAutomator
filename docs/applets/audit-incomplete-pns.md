# `audit-incomplete-pns` — bitácora

Tool standalone para DevTools (`tools/audit-incomplete-pns.js`). Compara los PNs
de Steelhead contra el CSV original de bulk-upload y detecta huecos (labels,
specs, racks, predictivos, custom inputs, precio, dimensiones, descripción,
proceso) para emitir un CSV de recuperación + reporte JSON.

## 2026-05-25 — Fix NN: criterio duplicate-params / paramProcessNode (alineación con bulk-upload 1.4.38)

### Petición
Cita usuario: "no nos faltaría actualizar el audit-incomplete para que considere un parámetro duplicado como error?"

Con la regla nueva (bulk-upload 1.4.38 + spec-migrator 0.4.3), un PN cargado correctamente debe tener **1 row vivo por SpecField con `processNodeId=null`**. El auditor sólo flageaba "0 params" (línea 1231 pre-fix); cualquier duplicación o residuo con processNode pasaba como OK silenciosamente.

### Fix
`tools/audit-incomplete-pns.js:1234-1265` — tras el check de `linkedParams` vacío, agrupar los params vivos por `specFieldId` (vía `specFieldParamBySpecFieldParamId.specFieldSpecBySpecFieldSpecId.specFieldBySpecFieldId.id`) y emitir 2 nuevos tipos de issue:

| Issue | Trigger | Significado |
|---|---|---|
| `duplicateParams` | >1 row vivo en el mismo `specFieldId` | Hay que correr validate-duplicate-params (spec-migrator 0.4.3) o re-cargar con bulk-upload 1.4.38+. |
| `paramProcessNode` | cualquier row vivo con `processNodeId !== null` | El row debería tener `processNodeId=null`. Bulk-upload 1.4.38+ re-pasará y lo reescribirá, o spec-migrator lo archiva. |

Defensivo: si la query persistida `GetPartNumber` no resuelve el `specFieldId` nested, el param se ignora (no falla la auditoría). El validator dup-params en spec-migrator 0.4.1+ confirma que ese path SÍ se resuelve en la query actual.

Output shape:
```js
{ field: 'duplicateParams', specField: 'Espesor', count: 2, rowIds: [12345, 12346] }
{ field: 'paramProcessNode', specField: 'Adherencia', rowIds: [12347] }
```

Aparecen en el conteo por tipo de issue (línea 1413, `i.field + (i.key ? ':'+i.key : '')`) y bajan al CSV de recuperación + JSON como cualquier otro issue.

### Lección
- **Criterios de auditoría deben reflejar la regla actual de bulk-upload, no la histórica.** El check "PN sin params" cubría 1.4.0, no la regla 1.4.38. Cada vez que cambia la regla de bulk-upload, audit-incomplete-pns debe revisar criterios.
- **Defensa por skip en lugar de assume**: si la query no resuelve un nested field, mejor saltar el param que crashear o emitir un falso positivo masivo.

### Pendiente de validación
- [ ] Correr audit sobre un lote conocido con duplicados (PNs pre-1.4.38) y verificar que `duplicateParams` aparezca en el summary y CSV. PN 3027938 / 3027939 son candidatos históricos.
- [ ] Confirmar que post-recarga con bulk-upload 1.4.38, el conteo `duplicateParams: 0` y `paramProcessNode: 0`.

---

## 2026-05-25 — Fix MM: cache de fingerprint en fase 5.4b (OOM en P1)

### Síntoma
Auditando P1 (3692 filas / 2132 keys ambiguos / 6208 candidatos a discriminar),
la pestaña se acercaba a OOM en mid-discriminación: `Mem 3199/4096 MB (78%)` con
35% de progreso (2179/6208). La fase 5.4b no tiene resume — un crash significa
re-correr 5.4b entera.

### Diagnóstico
`tools/audit-incomplete-pns.js:871` (pre-fix) declaraba `candidateFullCache =
new Map()` y guardaba el `partNumberById` COMPLETO (labels, specs, racks,
predictedInventoryUsages, customInputs) para los 6208 candidatos. Pero el único
uso posterior (línea 916) extraía solo 3 strings vía `fingerprintOf(...)`:
`quoteIBMS + metalBase + labelsSorted`.

Cuenta: 6208 PNs × ~50 KB cada uno ≈ ~300 MB solo del cache. Sumado a
`allParts` (3692 rawRow byte-exact), catálogos y `ambiguousByCandidatesKey`,
llegaba al cap dinámico de Chrome tab.

P3 (audit anterior) no lo expuso porque tenía muchísimos menos buckets ambiguos.
P1 multiplicó por ~100x los candidatos.

### Fix
- `tools/audit-incomplete-pns.js:874` — rename `candidateFullCache` →
  `candidateFpCache` con shape `Map<pnId, { quoteIBMS, metalBase, labelsSorted }>`.
- `tools/audit-incomplete-pns.js:878-901` — `fingerprintOf` y `csvFingerprint`
  movidos fuera del `if (ambiguousByCandidatesKey.size)` para estar en scope del
  callback del runPool.
- `tools/audit-incomplete-pns.js:919` — runPool callback extrae fingerprint inline
  con `candidateFpCache.set(id, fingerprintOf(d.partNumberById))` y descarta el
  PN completo al salir del scope (GC inmediato).
- `tools/audit-incomplete-pns.js:925-928` — el loop de discriminación lee
  fingerprint precomputado (no re-llama `fingerprintOf` por bucket).

Memoria del cache: ~300 MB → ~500 KB (factor ~600x).

### Lección
- **Cachear lo que necesitas, no lo que recibes**. El persisted query de
  GetPartNumber trae el universo del PN; si solo necesitas 3 strings de eso,
  extrae-y-descarta en el callback async, no después.
- **OOM en pool concurrente es acumulativo, no instantáneo**. Bajar `concurrency`
  no ayuda — el cache crece linealmente con `allAmbCands.length`, no con
  in-flight count. El fix tiene que ser el shape del cache.
- **Falta de resume en fase 5.4b** es un agravante. Pendiente derivado:
  persistir `ambiguousByCandidatesKey` + `candidateFpCache` cada N candidatos
  para reanudar si crashea. Hoy un OOM = re-correr 5.4b completa.

### Pendientes derivados
- [ ] Resume de fase 5.4b (persistir cache + bucket progress cada 50 PNs).
- [ ] Considerar collapsar 5.4b + 5.5 en single-pass: 1 fetch `GetPartNumber`,
      extraer fingerprint para discriminar y comparar campo-a-campo para
      auditoría. Ahorra 50% queries cuando hay muchos ambiguos. Requiere
      reordenar el flujo (discriminación necesita TODOS los fingerprints del
      bucket antes de elegir → no se puede hacer 100% streaming).

## 2026-05-25 — Fix LL: `usagesLimit:1` → `100` (falsos positivos predictive missing)

### Síntoma
Tras correr Fix HH/JJ/KK del bulk-upload (1.4.28-1.4.31), el re-audit del CSV
recovery de P3 (404 rows) seguía reportando **404 incompletos / 430 predictive
missing** idéntico al pre-fix. El usuario verificó manualmente en Steelhead UI
(PN 2867612): `Sterlingshield S (Antitarnish): 0.0063 LTS` (= valor del CSV).
**Los predictives SÍ estaban aplicados, visibles, no archivados.**

### Diagnóstico
Query manual `GetPartNumber({partNumberId, usagesLimit:1, usagesOffset:0})`
devolvió **solo 1 nodo** (`Plata Fina`). Misma query SIN `usagesLimit/usagesOffset`
devolvió los 2 esperados (`Plata Fina` + `Sterlingshield S`).

`usagesLimit` controla la paginación de `predictedInventoryUsagesByPartNumberId.nodes`,
no solo de algún otro campo de "usages". Con `limit:1`:
- El audit traía 1 predictive arbitrario por PN.
- El primer match servía como "existe en server"; los demás se reportaban como missing.
- Conteos perfectamente sesgados por nombre del primer predictive (Plata Fina cae
  primero en muchos PNs → otros como Sterlingshield S quedan fuera y se ven missing
  en 236 PNs, etc.).

### Fix
- `tools/audit-incomplete-pns.js:889` (discriminación de ambiguos)
- `tools/audit-incomplete-pns.js:1017` (comparación principal por fila)

Ambas llamadas cambian `usagesLimit: 1` → `usagesLimit: 100`.

### Lección
- **Cualquier parámetro de paginación en un persisted query es sospechoso por
  default**. El comentario en `bulk-upload.js:1299` decía "usagesLimit=1 (mínimo
  aceptado por el server, no usamos los usages)" — esa fue una falsa atribución:
  el comentario era válido para `fetchCandidateSpecs` (donde NO se leen los usages)
  pero al copiar el patrón a este audit, sí necesitábamos los usages.
- **bulk-upload pre-fetch (línea 4197)** llama `GetPartNumber({partNumberId})` SIN
  `usagesLimit` — por eso bulk-upload SÍ veía los predictives correctamente y los
  actualizaba. Esa asimetría hizo que el problema pareciera ser de bulk-upload
  durante 3 días de iteración (Fix JJ + Fix KK), cuando realmente vivía en el audit.
- **`archivedAt` en `predictedInventoryUsagesByPartNumberId.nodes`** NO está expuesto
  por el persisted query actual. La salida es siempre `undefined` (no `null`). El
  filtro `.filter(p => !p.archivedAt)` en el audit y el `predictedUnarchives` en
  bulk-upload (Fix JJ) quedan inertes — pero defensa en profundidad útil si Steelhead
  algún día expone el field.
- **Falsos positivos en clusters perfectos por nombre** indican bug de query/shape,
  no comparator. Mismo patrón que el matching fix de 2026-05-23 (Map<key, single>).
  Cuando un campo falla con conteo bimodal raro (236+159+28+6+1, todos de materiales
  específicos, otros 4 materiales en 0), sospecha paginación o filtro de la query
  antes que datos sucios.

### Pendiente de validación
- [ ] Re-correr audit (no recovery del CSV, no toca bulk-upload) sobre P3 con
      `usagesLimit:100`. Incompletos esperados: bajar de 404 a ~5-15 (los reales:
      el huérfano fila 99, los 21 duplicateQuoteIBMS pendientes de DELETE manual,
      labels reales, etc.). Predictive missing: bajar de 430 a ~0.
- [ ] Si bajan a ~0, marcar Fix JJ (bulk-upload 1.4.30) y Fix KK (1.4.31) como
      "código inerte pero correcto" — no requieren revert.

## 2026-05-23 — Matching fix: discriminación de candidatos ambiguos + dup-scan standalone

### Síntoma
Re-audit del CSV P3 (1854 PNs) reportó **700 incompletos (38%)**. Cluster sospechoso: ~440 PNs con TODOS los custom inputs IBMS desalineados (`quoteIBMS`, `estacionIBMS`, `notasAdicionales`, `piezasCarga`, `cargasHora`) y ~235 con descripción completamente distinta (CSV "BARRA 1/4X2 1/2X120" vs server "CONECTOR COMODITY 281D" — productos físicamente diferentes).

### Diagnóstico
Fase 5.3 usaba `Map<key, single>` con `chosen = max(ID)` (línea 660-731 pre-fix). Cuando un cliente tenía 2+ PNs server con mismo nombre (caso común: el cliente recicla el código de parte para productos diferentes), el Map colapsaba al de mayor ID y descartaba el resto. Resultado: rows distintas del CSV con mismo `pn+cliente` resolvían al MISMO `pnId` server, comparando campos del CSV-A contra PN-B.

Evidencia en el JSON del re-audit:
- 138 PNs distintos con 291 rows que comparten `pnId` (153 rows "sobrantes").
- 235 PNs con description sin palabras en común entre CSV y server (smoking gun).
- 314 PNs con los 5 ci sospechosos simultáneamente.

Total falsos positivos estimados por bug de matching: **~150-300 de los 700** (~25-45%).

### Fix
1. **`pnByKey` ahora es `Map<key, Array>`** (audit-incomplete-pns.js:660) — guarda TODOS los candidatos exactos (filtro `n.name.toUpperCase().trim() === nameUpper`, sin colapsar).
2. **Fase 5.4b nueva** — discriminación de keys ambiguos (length ≥ 2):
   - Fetch `GetPartNumber` en pool a cada candidato.
   - Extract fingerprint: `quoteIBMS` (`customInputs.DatosAdicionalesNP.QuoteIBMS`) + composite (`metalBase + labels sorted`).
   - Para cada row CSV ambigua: matchear por QuoteIBMS si CSV lo tiene; fallback a composite (`metalBase + labels`) si no.
   - 1 match → resolver con `via=quoteIBMS|composite`. 0 → unresolved `ambiguousMatch`. ≥2 con mismo QuoteIBMS → unresolved + push a `duplicatesRequiringDelete`.
3. **Detección server-side de duplicados QuoteIBMS** — si 2+ candidatos del mismo bucket (mismo PN + cliente) comparten `quoteIBMS` no vacío, reportar como duplicado real que requiere **DELETE manual** en Steelhead (no se puede archivar — la unique-constraint del cliente queda viva).
4. **Modo standalone (sin CSV)** — botón "🚨 Buscar duplicados QuoteIBMS": input de cliente, pagina `AllPartNumbers` (que SÍ devuelve `customInputs`), agrupa por `(customerId, quoteIBMS)`, reporta buckets length ≥ 2. Barato: solo paginación, sin GetPartNumber por PN.

### Lección
- **Map shape importa**: `Map<key, single>` colapsa silenciosamente. Si la clave NO es naturalmente única en el dominio (PN+cliente NO lo es en Steelhead), guardar Array y discriminar después es obligatorio.
- **QuoteIBMS es el discriminador real**: el ID de cotización IBMS es unique-en-el-mundo. Es el primer candidato a "natural key" para PNs venidos del flujo IBMS→SH.
- **Composite fallback necesario para post-IBMS**: cuando ya no haya IBMS (cargas directas), discriminar por `metalBase + labels(acabados) + linea`. Es la "fingerprint de negocio" de un PN.
- **`AllPartNumbers` ya trae `customInputs`** — verificado en `bulk-upload.js:1125`. No necesitas `GetPartNumber` para extraer QuoteIBMS en scans masivos.
- **Falsos positivos masivos siempre indican bug de resolución, no de comparador**: cuando los issues caen en clusters perfectos (~mismo conteo en N campos), sospecha matching incorrecto, no N bugs simultáneos en N comparadores distintos.

### Por qué P3 dejó tantos huecos (predictives 733, labels 413, specs 420, racks 337)
Después del fix de matching, estos siguen siendo issues legítimos. P3 se cargó pre-Fix-Y (1.4.15), cuando bulk-upload tenía bugs documentados en `bulk-upload.md:246`:
- PNs que fallaban se marcaban como `completed` → labels/specs/predictives nunca se aplicaban (Fix Y, 1.4.15).
- `specsToApply` no filtrado → primer SavePartNumber fallaba con unique constraint (Fix C).
- Cache no invalidado → STEP 6b skipeaba params recién agregados (Fix I).
- Network 416/intermitente → cascada sin retry adecuado.

Esos PNs requieren recarga del CSV reducido emitido por audit (campos reales faltantes).

### Validación post-fix (re-audit P3 2026-05-24T00:52)

| Métrica | Antes (bug Map colapsado) | Ahora (fix-2026-05-23) |
|---|---|---|
| Incompletos | 700 | **426** (-39%) |
| pnIds compartidos por 2+ rows CSV | 138 | **1** |
| 5-ci IBMS sospechoso simultáneo | 314 | **0** |
| `description` sin palabras en común | 235 | **0** |
| `ci:quoteIBMS` desalineado | 449 | **1** |
| `ci:estacionIBMS` desalineado | 427 | **1** |
| `ci:cargasHora` desalineado | 449 (cluster) | **1** |
| `labels` | 413 | 34 |
| `specs` | 420 | 4 |
| `process` | 419 | 34 |
| `rack` | 337 | 25 |

Discriminación: **612 rows** resueltas por QuoteIBMS, **22 buckets** server con
duplicados QuoteIBMS reales (todos SCHNEIDER ELECTRIC MEXICO), **34 unresolved**
(12 `ambiguousMatch` real + 22 `duplicateQuoteIBMS`).

Los 426 restantes son legítimos; `predictive: 437` es el issue dominante post-fix —
consistente con el bug pre-Fix-Y (bulk-upload 1.4.15) que dejaba huecos de
labels/specs/predictives cuando un PN fallaba parcialmente.

### Pendientes de validación
- [ ] Standalone dup-scan: probar con "SCHNEIDER ELECTRIC MEXICO" (≥10k PNs) — debe paginar a ~3 min y reportar buckets duplicados similares a los 22 ya detectados vía CSV.
- [ ] Generar el CSV reducido (426 rows) y re-cargar con bulk-upload 1.4.25 para validar que los issues legítimos se resuelven.

### Pendientes derivados
- [ ] Migrar `saveResume/loadResume/clearResume` a IndexedDB (tarea pendiente — localStorage tope a 5-10 MB para audits ≥ 3000 PNs).
- [ ] El audit usa GetPartNumber en fase 5.4b para discriminar y luego DE NUEVO en fase 5.5 para comparar. Optimización futura: cachear el resultado de 5.4b para reusar en 5.5 (ahorra ~50% queries cuando hay muchos ambiguos).
- [ ] Modo standalone: agregar opción "todos los clientes del dominio" (sin input). Hoy requiere especificar cliente uno-por-uno.
- [ ] Test unitario para fingerprint matching (CSV+server con quoteIBMS, sin quoteIBMS, mismo composite, etc.) — actualmente solo se prueba `comparePartNumber`.
