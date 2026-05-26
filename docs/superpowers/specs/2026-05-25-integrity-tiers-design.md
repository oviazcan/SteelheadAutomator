# Integridad multi-tier en el Auditor — spec

**Fecha:** 2026-05-25
**Autor:** Omar Viazcán + Claude (Opus 4.7)
**Estado:** diseño aprobado (pendiente plan de implementación)

## Objetivo

Reemplazar la sección "Integridad" del applet Auditor de PNs por un detector de duplicados con tres niveles de severidad (DURO, MEDIO, SUAVE), con desambiguación por score, archivado inline batch, y export de CSV "candidatos a DELETE" para Steelhead support.

## Motivación

La sección Integridad actual (`remote/scripts/auditor.js:102-105`) tiene 3 checkboxes: `duplicates` (mismo nombre exacto), `similar` (Levenshtein ~80%), `no-customer`. La detección por "mismo nombre exacto" es ingenua — no diferencia entre:

1. **Duros**: dos PNs cargados desde la misma cotización IBMS (mismo `QuoteIBMS`). Choca con la unique-constraint del cliente; requiere DELETE manual en Steelhead, no archivado.
2. **Medios**: dos PNs del mismo cliente con mismo nombre + mismo metal canónico + mismo set de acabados canónico, pero distinto `QuoteIBMS` o cargados en distintos momentos. Resoluble con archivado.
3. **Suaves**: mismo nombre + cliente, pero data asimétrica (uno enriquecido, otro huérfano). Resoluble con archivado, a veces con DELETE.

Sin esta diferenciación, el usuario tiene que inspeccionar manualmente cada par de duplicados — proceso intratable con ~12k+ PNs/cliente.

## Arquitectura

```
remote/scripts/duplicate-tiers.js  ← single source of truth
  • Puro funcional (sin DOM/fetch).
  • Expone window.SADuplicateTiers.
  • Cargado vía extension/background.js (globals map) en el applet.
  • Cargado vía fetch+eval en el DevTools tool.
                │
       ┌────────┴─────────┐
       ▼                  ▼
remote/scripts/      tools/audit-incomplete-pns.js
  auditor.js              (DevTools, uso interno)
  (applet en              • Nuevo botón "Scan integridad
   extensión)               (duro/medio/suave)"
  • Checkboxes              • Mismo flujo, panel propio
    Integridad              • Flujo CSV-driven actual
    rediseñados               queda intacto
  • Tarjetas bucket
  • Archivar batch
  • CSV DELETE
```

### Por qué single source of truth
La asimetría histórica entre `bulk-upload.js` (sin `usagesLimit`) y `tools/audit-incomplete-pns.js` (con `usagesLimit:1`) — Fix LL del 2026-05-25 — costó 3 días de debug por divergencia silenciosa. El módulo central evita repetir ese patrón.

### API del módulo
```js
window.SADuplicateTiers = {
  // Bucketización (pase 1, solo data de AllPartNumbers)
  hardBuckets(pns, opts),       // → [{ quoteIBMS, members: [...] }]
  mediumBucketsCandidates(pns, opts),  // → [{ customerId, name, members: [...] }] — buckets a refinar en pase 2
  softBucketsCandidates(pns, opts),    // → [{ customerId, name, members: [...] }] — buckets a refinar en pase 2

  // Refinamiento (pase 2, requiere GetPartNumber enriquecido)
  refineMediumBuckets(candidates, detailsByPnId, opts),  // aplica metalBase canónico + acabados canónicos
  refineSoftBuckets(candidates, detailsByPnId, opts),    // aplica regla de asimetría de acabados

  // Scoring
  scoreFor(pn, details),        // → number
  pickWinner(bucket),           // → pnId del ganador sugerido

  // Helpers
  canonicalMetal(metalBase, metalEquivalents),
  canonicalFinishings(labels, nonFinishLabelNames),
  isNonFinishLabel(name, nonFinishLabelNames),
};
```

`opts` siempre incluye:
- `nonFinishLabelNames: string[]` (de `config.json:344`)
- `metalEquivalents: string[][]` (de `config.json:348`)

El módulo NO conoce de Apollo, hashes, persisted queries, ni del DOM.

## Reglas de cada tier

### DURO
- **Trigger:** dos o más PNs comparten `customInputs.DatosAdicionalesNP.QuoteIBMS` no vacío.
- **Cross-customer:** sí. QuoteIBMS es unique-en-IBMS-global; aparecer en dos clientes es duplicado peor.
- **Precedencia:** un PN clasificado como DURO se excluye de MEDIO y SUAVE.
- **Acción:** sugerir ganador por score, archivar al resto vía `UpdatePartNumber({id, archivedAt: now})`, y emitir CSV "candidatos a DELETE" con **todos los perdedores** del bucket. El ganador no entra al CSV.

### MEDIO
- **Trigger:** dos o más PNs comparten **todas** estas claves:
  1. `customerId`
  2. `name` en UPPER+trim
  3. `metalBase` canónico (vía `metalEquivalents`)
  4. set de acabados canónico (labels filtrados por `nonFinishLabelNames`, ordenados ASC, joineados con `|`)
- QuoteIBMS no importa (puede ser distinto, vacío en uno, lleno en otro).
- **Precedencia:** excluye PNs ya en DURO.
- **Acción:** ganador por score, archivar al resto. CSV de DELETE solo si el bucket cumple la regla de "≥1 sin QuoteIBMS" (ver sección "CSV DELETE").

### SUAVE
- **Trigger:** dos o más PNs comparten `(customerId, name)` y el bucket es **asimétrico** en acabados:
  - ≥1 miembro tiene acabados (después de filtrar nonFinish).
  - ≥1 miembro tiene **cero** acabados (o solo nonFinish).
- Si todos tienen acabados (aunque distintos) → NO es candidato (productos legítimamente distintos del mismo nombre).
- Si todos están vacíos → NO es candidato (probable error masivo de carga, requiere fix de fuente).
- **Precedencia:** excluye PNs ya en DURO o MEDIO.
- **Acción:** ganador por score, archivar al resto. CSV de DELETE bajo la regla "≥1 sin QuoteIBMS".

### Precedencia formalizada
Un PN está en a lo más **un** bucket en total. Orden de precedencia: DURO > MEDIO > SUAVE.

### PNs sin cliente
`customerId == null` → excluido de los tres tiers (la regla `(customerId, name)` no aplica). Estos PNs siguen flageándose en el criterio `no-customer` del Auditor (sin cambios).

## Scoring

```
score(pn) =
  Críticos (no debe quedar PN activo sin esto — peso 5 cada uno):
  + (hasProcess         ? 5 : 0)      // defaultProcessNodeId != null
  + (specsCount > 0     ? 5 : 0)

  Enriquecimiento confiable (peso 2 cada uno):
  + (hasQuoteIBMS               ? 2 : 0)   // customInputs.DatosAdicionalesNP.QuoteIBMS no vacío
  + (hasDefaultPrice            ? 2 : 0)
  + (hasNotasAdicionalesIBMS    ? 2 : 0)   // customInputs.NotasAdicionales no vacío

  Por cantidad (1 punto por item):
  + finishingsCount      (labels filtradas por nonFinishLabelNames)
  + specsCount
  + racksCount
  + predictivesCount
  + unitConversionsCount
  + dimCustomValuesCount  (Línea/Departamento contable)

  Otros (1 punto cada uno):
  + (hasDescription  ? 1 : 0)    // descriptionMarkdown.trim() no vacío
  + (hasGroup        ? 1 : 0)    // partNumberGroupId != null
  + (hasMetalBase    ? 1 : 0)    // customInputs.DatosAdicionalesNP.BaseMetal no vacío
  + (hasSat          ? 1 : 0)    // customInputs.DatosFacturacion.CodigoSAT no vacío

Tiebreaker 1: createdAt más reciente gana
Tiebreaker 2: id mayor (más reciente, datos mejor validados al final) gana
```

**Consecuencia esperada:** un PN sin proceso o sin spec **nunca** gana contra uno que sí los tiene, salvo que el otro lado esté igualmente vacío. Esto cumple la regla "no debe quedar ningún NP activo sin proceso o sin Spec".

## CSV "candidatos a DELETE"

### Quién entra

| Tier | ¿Va al CSV? | Quiénes |
|---|---|---|
| DURO | Sí, siempre | Todos los **perdedores** del bucket (no el ganador) |
| MEDIO con ≥1 miembro sin QuoteIBMS | Sí | Los perdedores |
| MEDIO con todos sus miembros teniendo QuoteIBMS distinto no-vacío | No | (archivan, pero no DELETE) |
| SUAVE con ≥1 miembro sin QuoteIBMS | Sí | Los perdedores |
| SUAVE con todos sus miembros teniendo QuoteIBMS distinto no-vacío | No | (archivan, pero no DELETE) |

Los PNs que ya estaban archivados antes del scan **también** entran al CSV si encajan en la regla (Steelhead support igual los borra).

### Formato

Archivo: `pn_delete_candidates_<YYYY-MM-DD>.csv`

Columnas:
```
tier, bucketKey, pnId, pnName, customer, customerId, quoteIBMS,
metalBase, finishings, status, createdAt, score, winnerPnId, razon
```

- `bucketKey` por tier:
  - DURO: `quoteIBMS=<valor>`
  - MEDIO: `<nameUpper>||<customerId>||<metalCanon>||<finishingsCanon>`
  - SUAVE: `<nameUpper>||<customerId>`
- `status`: `active | archived | archived-by-this-run`
- `razon` ejemplos:
  - `"DURO: comparte QuoteIBMS 84531 con PN-3349"`
  - `"MEDIO sin QuoteIBMS: bucket Tornillo 1/4 · SCHNEIDER · Cobre · [Niquel,Estaño]"`

## Pases de fetch

### Pase 1 — `AllPartNumbers` paginado
- 2 sub-pasadas: `includeArchived: 'NO'` luego `'YES'`, dedup por `id` (patrón estándar `bulk-upload.js:1180`).
- Sintetizar `archivedAt = ARCHIVED_SENTINEL` para PNs que aparecen solo en `YES`.
- Filtro client-side por `customerFilter` si el usuario lo provee.
- Datos que trae `AllPartNumbers`:
  - `id, name, customerByCustomerId.{id,name}, createdAt`
  - `customInputs` completo → `QuoteIBMS`, `BaseMetal`, `NotasAdicionales`, `CodigoSAT`
  - `labels` (vía `partNumberLabelsByPartNumberId.nodes[].labelByLabelId.{name, color}`)
- Bucketización in-memory:
  - DURO completo (suficiente data en pase 1).
  - MEDIO/SUAVE candidates: buckets `(customerId, nameUpperTrim)` con length ≥ 2. Se refinan en pase 2.

### Pase 2 — `GetPartNumber` por candidato
- Solo PNs en buckets ≥ 2 (típicamente 5-10% del dominio).
- Pool de concurrencia 6 (mismo patrón que `auditor.js:309`).
- `withRetry` 3 intentos con backoff `[0, 1000, 2000]`.
- Trae los signals que `AllPartNumbers` no expone:
  - `defaultProcessNodeId`
  - `partNumberSpecsByPartNumberId.nodes` (specsCount)
  - `partNumberRackTypesByPartNumberId.nodes` (racksCount)
  - `inventoryPredictedUsagesByPartNumberId.nodes` (predictivesCount)
  - `inventoryItemByPartNumberId.inventoryItemUnitConversionsByInventoryItemId.nodes` (unitConversionsCount)
  - `descriptionMarkdown`
  - `partNumberGroupId`
  - `dimensionCustomValueIds`
  - `partNumberPricesByPartNumberId.nodes` (prices, hasDefaultPrice)
  - `customInputs.NotasAdicionales` (redundante con pase 1, defensive)
- Después del pase 2: `refineMediumBuckets`, `refineSoftBuckets`, `scoreFor`, `pickWinner`.

### Costo estimado
Para un dominio de ~12k PNs activos + ~5k archivados (~17k total):
- Pase 1: ~34 queries `AllPartNumbers` (paginado 500), ~30-60s.
- Pase 2: ~850-1700 `GetPartNumber` con concurrency 6, ~3-6 min.
- Total: ~4-7 min.

## UI (en el applet Auditor)

### Checkboxes Integridad (reorganizada)
```
Integridad
☐ PNs duplicados — DUROS (mismo QuoteIBMS)
☐ PNs duplicados — MEDIOS (mismo metalBase + acabados + cliente)
☐ PNs duplicados — SUAVES (mismo nombre + cliente, acabados asimétricos)
☐ Sin cliente asignado
☐ PNs por similitud de nombre (~80%)   ← se conserva, ortogonal
─────
Toggle: ☑ Incluir archivados en el scan (default ON)
```

El criterio `duplicates` actual (mismo nombre exacto) se elimina — queda absorbido por los tres tiers. El `similar` (Levenshtein) se conserva (resuelve typos, no data dup).

### Tarjetas de bucket (3 secciones colapsables, una por tier)

```
┌─ DURO · QuoteIBMS: 84531 ──────────────── 🚨 candidato a DELETE ────┐
│  ☑ Aplicar acción a este bucket                                     │
│  ○ PN-3349 "Tornillo 1/4" · SCHNEIDER · score 23 · activo · 2026-04 │ ← ganador (radio marcado)
│  ● PN-2207 "Tornillo 1/4" · SCHNEIDER · score 11 · activo · 2025-12 │
│  ○ PN-1801 "Tornillo 1/4" · ALSTOM     · score  8 · archivado      │
│  [Archivar los no seleccionados]   [Ver detalles ▼]                │
└────────────────────────────────────────────────────────────────────┘
```

Detalles expandibles ("Ver detalles ▼"): desglose del score por miembro (hasProcess ✓/✗, specsCount, racksCount, predictivesCount, etc.).

### Control por bucket
Checkbox `☑ Aplicar acción a este bucket` (default ON). Si el usuario lo desmarca:
- El bucket no entra al batch `Archivar descartados`.
- Sus perdedores no van al CSV de DELETE.
- Queda visible como `⏭ Saltado por el usuario`.

### Botonera global
```
[Archivar TODOS los descartados (47 PNs)]
[Descargar CSV candidatos a DELETE (12 PNs)]
[Descargar JSON completo del audit]
```

### Toggle "Incluir archivados"
- Default ON.
- Apagado pre-scan: pase 1 solo trae activos. Más rápido, pero pierdes duros donde uno está archivado.
- Apagado post-scan: filtro client-side oculta archivados de la UI (sin re-fetch). Reversible.

## Acción: archivar batch

Mutation: `UpdatePartNumber({id, archivedAt: new Date().toISOString()})`.

- Pool concurrency 5 (alineado con `concurrency.savePartNumber`).
- `withRetry` 3 intentos con backoff `[0, 1000, 2000]`.
- Idempotente: si `archivedAt != null`, se salta. Se marca `wasAlreadyArchived: true` en el reporte.
- Progress inline: `Archivando 12/47 (PN-3349 "Tornillo 1/4")...`.
- Resumen final: `✓ 45 archivados · ⏭ 2 ya estaban · ✗ 0 fallaron`.
- Errores se listan con su mensaje y entran al JSON output.

## UX post-archivado

- Miembros archivados-por-la-run se rayan en su tarjeta (no se quitan).
- Bucket marcado `✓ Resuelto (archivado)` cuando todos los perdedores se archivaron con éxito.
- Bucket marcado `⚠ Parcial` si hubo fallos. Botón `Reintentar fallidos` que re-ejecuta solo los `archived: false` sin re-scan.

## Manejo de errores

### Pase 1 falla
- Sin tarjetas, mensaje de error visible. Sin estado parcial — se aborta.

### Pase 2 falla parcialmente
- Si `GetPartNumber` falla 3 reintentos para un PN: score se calcula con lo que sí trae `AllPartNumbers` (hasQuoteIBMS, hasMetalBase, hasNotas, finishingsCount). Tarjeta del PN muestra `⚠ datos incompletos · score parcial 7`.
- Si todo el bucket falla → ganador no determinable, radio sin pre-selección, archivado deshabilitado para ese bucket.

### Detención mid-scan (`⏹ Detener`)
- Pase 1 incompleto → abort + mensaje "pase 1 incompleto, resultados parciales no disponibles".
- Pase 2 incompleto → tarjetas solo con buckets completos. Buckets parciales marcados `⚠ scan parcial` y archivado deshabilitado.

### Race entre pase 1 y pase 2
- Si un PN se archiva externamente entre pase 1 y pase 2: `GetPartNumber` igual responde. Sin acción especial.

## Integración en consumidores

### `extension/background.js`
Añadir a `globals`:
```js
'scripts/duplicate-tiers.js': 'SADuplicateTiers',
```

### `remote/scripts/auditor.js`
- Antes del scan, asegurar que `window.SADuplicateTiers` esté cargado.
- Reemplazar los criterios `duplicates` y `similar` (parcialmente) en `CRITERIA`. Conservar `similar` y `no-customer`.
- Implementar la sección Integridad nueva en `run(options)`: cuando alguno de los tres tiers está seleccionado, ejecutar pases 1+2, bucketizar via `SADuplicateTiers`, renderizar tarjetas, exponer botones de acción.

### `tools/audit-incomplete-pns.js`
- Después de fetch de `config.json` (línea 49-55), fetch+eval del módulo:
  ```js
  const tiersUrl = 'https://oviazcan.github.io/SteelheadAutomator/scripts/duplicate-tiers.js';
  const tiersCode = await fetch(tiersUrl, { cache: 'no-cache' }).then(r => r.text());
  new Function(tiersCode)();
  ```
- Reemplazar el botón `🚨 Buscar duplicados QuoteIBMS` (línea 580) por `🔍 Scan integridad (duro/medio/suave)` con el mismo flujo.
- Flujo CSV-driven actual (fase 5.4b y siguientes) queda intacto.

### UI compartida (decisión)
Renderer de tarjetas (HTML+CSS string) NO entra al módulo. Vive duplicado en cada consumidor con comentario `// SYNCED WITH auditor.js bucket card v1`. Si la divergencia visual eventualmente duele, se promueve a `duplicate-tiers-ui.js` en un follow-up.

## Deploy

Bump de `remote/config.json` `version` cuando publiquemos `duplicate-tiers.js` y la versión actualizada de `auditor.js` a `gh-pages`. Sigue procedimiento estándar de `CLAUDE.md` (sync byte-exact verificable con `tools/check-deploy.sh`).

## Out of scope

- Resume entre sesiones del scan integridad. Alineado con `audit-incomplete-pns.md` que ya tiene "migrar resume a IndexedDB" pendiente.
- Migrar la fase 5.4b CSV-driven del DevTools tool al módulo nuevo. Coexisten; potencial follow-up.
- Promover el renderer de tarjetas a un módulo `duplicate-tiers-ui.js` compartido. Solo si la divergencia visual duele.
- Integrity check (SHA-256 hash) del módulo antes de evaluar — alineado con el pendiente "Integridad de scripts remotos" del audit pre-producción (`CLAUDE.md:115`).

## Bitácora destino

Cuando se implemente, abrir bitácora `docs/applets/integrity-tiers.md` (o expandir `docs/applets/audit-incomplete-pns.md` si se prefiere unificar). Decidir en el plan de implementación.
