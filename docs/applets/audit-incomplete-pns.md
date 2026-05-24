# `audit-incomplete-pns` — bitácora

Tool standalone para DevTools (`tools/audit-incomplete-pns.js`). Compara los PNs
de Steelhead contra el CSV original de bulk-upload y detecta huecos (labels,
specs, racks, predictivos, custom inputs, precio, dimensiones, descripción,
proceso) para emitir un CSV de recuperación + reporte JSON.

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
