# bulk-upload — Dedup por QuoteIBMS + composite con override manual

**Fecha**: 2026-05-20
**Estado**: Diseño aprobado, pendiente de plan de implementación
**Aplica a**: `remote/scripts/bulk-upload.js` (versión actual 1.0.0)
**Contexto operativo**: corrida masiva inicial de ~18,000 filas (Schneider Electric MX + ~79 clientes restantes), divididas en 4 cargas (ver CLAUDE.md → `bulk-upload 1.0.0`).

## 1. Problema

El `checkPNExistence` actual de `bulk-upload.js:653` decide MODIFICAR vs CREAR usando solo `(pn.name.toUpperCase(), customerId)` como llave. Esto es insuficiente por dos razones:

1. **Falsos matches**: un mismo cliente puede tener legítimamente el mismo PN.name varias veces, diferenciado por `metalBase` o por etiquetas de acabado. La llave actual colapsa esos PNs distintos en uno solo, modificando el equivocado.
2. **No aprovecha QuoteIBMS**: el campo `customInputs.DatosAdicionalesNP.QuoteIBMS` carga el número único de IBMS — la llave natural por excelencia para los PNs migrados de IBMS — pero hoy no participa en la decisión de match.

Adicional: los datos existentes en Steelhead tienen omisiones en `metalBase` y en etiquetas de acabado (la carga histórica no las validó con rigor), por lo que un composite estricto fallaría matches que sí son legítimos.

## 2. Objetivo

Reescribir la fase de clasificación PN-por-PN para que:

- Use **QuoteIBMS como llave autoritativa** (Pase 1) cuando esté presente.
- Use **composite `(customerId, name, metalBase, acabadosOrdenados)`** como segundo intento (Pase 2).
- Para casos sin match exacto pero con candidatos cercanos, ofrezca **override manual del usuario** en el preview (Pase 3).
- Cuando se decida MODIFY (auto o por override), el CSV sea **autoritativo en todos los campos** del PN destino.
- Mantenga compatibilidad con el flujo actual de QuoteIBMS vacío (carga futura de PNs que no vienen de IBMS).

## 3. Algoritmo de clasificación

Para cada fila del CSV, evaluar en orden y detenerse en el primer pase que resuelva:

### Pase 1 — QuoteIBMS (autoritativo, sin override)

```
SI csvRow.QuoteIBMS no está vacío:
    PN = buscar en Steelhead donde
        customerId == csvRow.customerId
        AND customInputs.DatosAdicionalesNP.QuoteIBMS == csvRow.QuoteIBMS
        AND NOT archivedAt
    SI PN encontrado:
        classification = MODIFY
        target = PN
        confidence = "ibms-exacto"
        STOP
```

### Pase 2 — Composite exacto (alta confianza, sin override)

```
composite_csv = (
    customerId,
    name.toUpperCase(),
    metalBase | "",
    acabadosOrdenados(labels)
)

PN = buscar en Steelhead donde composite_pn == composite_csv AND NOT archivedAt
SI PN encontrado:
    # Regla anti-colisión: si AMBOS lados tienen IBMS y son DISTINTOS,
    # entonces este composite chocó entre dos NPs legítimamente diferentes.
    # En cualquier otro caso (uno vacío, ambos vacíos, ambos iguales) → MODIFY.
    SI csvRow.QuoteIBMS != vacío AND PN.QuoteIBMS != vacío AND PN.QuoteIBMS != csvRow.QuoteIBMS:
        # NO matchear; continuar a PASE 3
    SINO:
        classification = MODIFY
        target = PN
        confidence = "composite-exacto" + (sufijo según caso: -pn-sin-ibms / -csv-sin-ibms / -ibms-coincide / -ambos-sin-ibms)
        STOP
```

### Pase 3 — Near-match (baja confianza, requiere override del usuario)

```
candidatos = buscar PNs en Steelhead donde
    customerId == csvRow.customerId
    AND name.toUpperCase() == csvRow.name.toUpperCase()
    AND NOT archivedAt

Ranking de candidatos (descendente):
    1. más campos coincidentes con csvRow (metalBase, acabados)
    2. QuoteIBMS vacío gana sobre QuoteIBMS no-vacío-pero-distinto
    3. id ascendente como tie-breaker determinista

Tomar top 3 candidatos.

DEFAULT: classification = NEW
override disponible para el usuario en el preview → MODIFY <candidato>
```

### Sin candidatos en ningún pase

```
classification = NEW
sin override
```

### `acabadosOrdenados`

```
acabadosOrdenados(labels) = labels
    .filter(l => l ∉ config.bulkUpload.nonFinishLabelNames)
    .sort()
    .join("|")
```

## 4. Configuración: blacklist de etiquetas no-acabado

Se agrega a `remote/config.json` en `steelhead.domain.bulkUpload`:

```json
"nonFinishLabelNames": [
  "SMY", "STX", "SXC", "SRG", "SCM", "SQ1", "SQ2",
  "NP desconocido", "En desarrollo", "Muestras", "Lote", "Obsoleto"
]
```

**Mantenimiento**: cuando aparezca una nueva planta o un nuevo status no-acabado en el catálogo de Steelhead, se agrega a la lista, se bumpea `version` en `config.json` y se sincroniza a `gh-pages`. No requiere cambios de código.

**Justificación de blacklist sobre whitelist**: los acabados son un conjunto abierto (cualquier nuevo proceso de acabado generará una nueva etiqueta), mientras que los no-acabados (plantas, estados de vida) son un conjunto pequeño y estable. Mantener una lista de exclusión es más sostenible que enumerar todos los acabados posibles.

## 5. Modo MODIFY: pisar todo desde CSV

Cuando una fila se clasifica como MODIFY (por cualquiera de los 3 pases o por override), el CSV es autoritativo. Se actualizan en el PN destino:

- `name` (rename via `SavePartNumber` si difiere)
- `customInputs` enteros, incluyendo `DatosAdicionalesNP.QuoteIBMS`, `BaseMetal`, `NumeroParteAlterno`, `EstacionIBMS`, `Plano`
- `labelIds` (sustitución completa, no merge)
- Todos los campos secundarios que el applet ya pisa hoy (specs, racks, unit conversions, dimensiones, default price, predictive usage, validation parameters)

## 6. UI de preview — sección Pase 3 + dropdown con links

El preview paginado existente (`bulk-upload.js` post-Fix 4 de 1.0.0) gana:

### 6.1 Header de decisiones pendientes

Sección colapsable arriba de la tabla:

> ⚠️ **N filas requieren tu decisión** — PNs con candidatos cercanos pero sin match exacto.

Si N=0, sección oculta. Si N>0, mostrar contador y botón "Aplicar default a todas las pendientes" (deja el default NEW en cada una, equivalente a no hacer nada).

### 6.2 Filtro nuevo en la tabla

Toggle "Solo decisiones pendientes" — al activarse filtra la tabla a filas con clasificación Pase 3.

### 6.3 Dropdown por fila Pase 3

En la columna de status de cada fila Pase 3:

- `Crear nuevo` (default, seleccionado)
- `Modificar #<id1>` — primer candidato, con link 🔗 que abre `https://app.gosteelhead.com/PartNumbers/<id1>` en pestaña nueva (`target="_blank"`)
- `Modificar #<id2>` — segundo (si existe)
- `Modificar #<id3>` — tercero (si existe)

Cada opción incluye un tooltip nativo (`title="..."`) con `metalBase`, lista de acabados y `QuoteIBMS` del candidato, para que el usuario tenga el contexto sin tener que abrir el link.

### 6.4 Persistencia del override

El override seleccionado se guarda en `state.classifications[csvRowKey].userOverride` y persiste a través de cambios de página del preview paginado. Al confirmar la corrida, se aplica.

## 7. Reporte XLSX al final de la corrida

Generar archivo descargable `bulk-upload-report-<runKey>-<timestamp>.xlsx` con SheetJS (ya cargado por `process-deep-audit` y `spec-params-bulk`).

### Hoja "Resumen"

| Métrica | Conteo |
|---|---|
| PNs procesados | total |
| Clasificación NEW (auto, sin candidatos) | int |
| Clasificación MODIFY por IBMS (Pase 1) | int |
| Clasificación MODIFY por composite (Pase 2) | int |
| Clasificación NEW pero con candidatos (Pase 3, default) | int |
| Clasificación MODIFY por override del usuario (Pase 3) | int |
| Errores | int |
| Omitidas | int |

### Hoja "Decisiones Pase 3"

Una fila por cada CSV row que entró a Pase 3 (haya o no aplicado override). Columnas:

- `CSVRow` — número de fila en el CSV
- `PN` — nombre del PN
- `Cliente`
- `QuoteIBMS_CSV` — valor del CSV
- `MetalBase_CSV`
- `Acabados_CSV` — lista joineada
- `DecisionFinal` — "NEW" o "MODIFY"
- `CandidatoElegido` — id del PN target si MODIFY, vacío si NEW
- `CandidatoLink` — URL clickeable a `https://app.gosteelhead.com/PartNumbers/<id>`
- `Candidato1`, `Candidato2`, `Candidato3` — ids de los candidatos ofrecidos (para auditoría posterior)

### Hoja "Errores"

Como hoy, más una columna `Clasificacion` que indique en qué pase falló (útil para debugging).

## 8. Cambios concretos a `bulk-upload.js`

| Componente | Cambio |
|---|---|
| `checkPNExistence` (line 653) | Renombrar a `classifyPNs`. Devuelve `Map<csvRowKey, ClassificationResult>` en lugar del `existMap` plano actual. Ver shape en §9. |
| Query `AllPartNumbers` (line 680) | Expandir response shape para traer `customInputs` (parseable como JSON para extraer `DatosAdicionalesNP.QuoteIBMS` y `BaseMetal`), `partNumberLabelsByPartNumberId.nodes.labelByLabelId.name`. Validar contra el scan que estos campos son consultables; si no, hacer follow-up con `GetPartNumber` para el shape completo. |
| Estrategia de fetch | Sustituir el loop actual de `for each (name, customerId) → AllPartNumbers(searchQuery=name)` por **prefetch por cliente**: para cada `customerId` único en el CSV, paginar todos sus PNs activos con `AllPartNumbers(customerIdFilter=[cid])` hasta agotar. Construir tres índices en memoria: `byIBMS`, `byComposite`, `byName`. Reutilizar el pool concurrente existente (`runPool`, concurrencia 5) para paralelizar páginas. |
| Preview modal | Agregar sección de decisiones pendientes, dropdown por fila Pase 3, persistencia del override entre páginas del preview. Mantener filtros existentes (por status, por cliente). |
| Modify path (`enrichWorker`, `bulk-upload.js:~1860`) | Cuando `classification === 'MODIFY'`, el `SavePartNumber` debe incluir `name` y `labelIds` completos del CSV (hoy solo pisa CI y otros). Verificar mutación exacta contra el scan reciente. |
| Bitácora XLSX | Nueva función `generateRunReport(state)` invocada al final de `execute()` (después del archivado), antes del `showResult`. Producir el XLSX y disparar descarga con `URL.createObjectURL` + click programático. |
| `config.json` | Agregar `steelhead.domain.bulkUpload.nonFinishLabelNames`. Bump version (1.0.0 → 1.1.0) y `lastUpdated`. |
| Resume schema (localStorage) | Extender el snapshot persistido con `state.classifications` para que la reanudación tras crash respete las decisiones de override que el usuario ya hizo en el preview pre-crash. |

## 9. Shape de `ClassificationResult`

```js
{
  csvRowKey: string,            // PN|customerId
  classification: 'NEW' | 'MODIFY',
  pase: 1 | 2 | 3 | null,       // null = sin candidatos
  confidence: string,           // 'ibms-exacto' | 'composite-exacto-pn-sin-ibms' | ...
  targetPnId: number | null,    // id del PN destino si MODIFY
  candidates: [                 // hasta 3, ranked
    {
      id: number,
      name: string,
      metalBase: string,
      labels: string[],
      acabados: string[],       // filtrados por blacklist
      quoteIBMS: string,
      url: string               // https://app.gosteelhead.com/PartNumbers/<id>
    }
  ],
  userOverride: number | null,  // id del candidato elegido, o null para mantener default
  finalTargetPnId: () => targetPnId || userOverride || null
}
```

## 10. Cobertura de casos

Cubre los 7 casos discutidos durante el brainstorming:

| # | CSV | Steelhead | Pase | Resultado |
|---|---|---|---|---|
| 1 | IBMS=X, name=A | PN con IBMS=X, name=A | 1 | MODIFY (trivial) |
| 2 | IBMS=X, name=B | PN con IBMS=X, name=A | 1 | MODIFY + rename a B |
| 3 | IBMS=X, name=A | PN con name=A, IBMS=vacío, composite OK | 2 | MODIFY + populate IBMS=X |
| 4 | IBMS=vacío, name=A | PN con IBMS=Y, name=A, composite OK | 2 | MODIFY + dejar IBMS=Y |
| 5 | IBMS=X, name=A | PN1 con IBMS=X, name=Z; PN2 con name=A, IBMS=Y | 1 | MODIFY PN1 |
| 6 | IBMS=X, name=A | PN con name=A, metalBase distinto, IBMS=vacío | 3 | Default NEW; usuario puede flipear a MODIFY |
| 7 | IBMS=X, name=A | nada parecido | — | NEW |

## 11. Tradeoffs explícitos

- **Cache por cliente vs query por fila**: el prefetch agrega ~45 requests por cliente grande (~9k PNs) pero ahorra ~9k queries individuales. En clientes con catálogos muy grandes (50k+ PNs) el prefetch puede tomar varios minutos al arranque; aceptable porque solo paga 1 vez por corrida. Si en el futuro algún cliente excede ese rango, considerar fallback a query-por-fila gated por cardinality threshold.
- **Override solo en Pase 3**: la UI no permite cambiar la decisión automática de Pases 1 y 2. Si esos pases dan match incorrecto (raro pero posible si la data de Steelhead tiene QuoteIBMS asignado mal), el usuario lo detecta en el reporte XLSX y corre una segunda pasada para corregir. Se evita la fatiga de revisión visual en una corrida de 18k.
- **Blacklist en config**: requiere mantenimiento manual cuando aparezcan nuevas plantas o nuevos estados. La alternativa de inferir vía categoría de label en Steelhead no aplica porque el shape de label no incluye categoría.

## 12. Fuera de alcance (Fase 2)

- Detección automática de "data sucia" en Steelhead (PNs con metalBase ausente o etiquetas inconsistentes) y propuesta de remediación. Por ahora el reporte XLSX de Pase 3 es la única señal.
- UI para editar el `nonFinishLabelNames` desde el panel sin tocar `config.json`. Por ahora se mantiene en config.
- Soporte para multi-revisión de PN (Steelhead permite historial; este flujo solo mira la versión activa). Por ahora no es requerimiento.

## 13. Plan de pruebas

A redactar como parte del plan de implementación posterior. Mínimo requerido antes del primer run productivo:

1. **CSV de 10 filas reales** con mix de casos 1, 3, 6 y 7. Validar el preview muestra correctamente las decisiones pendientes y que el override aplica al commit.
2. **CSV de 100 filas** con simulación de crash + resume. Validar que las decisiones de override sobreviven el resume.
3. **Validación cruzada en UI nativo** después del run: para una muestra de 5 PNs (incluyendo al menos 1 de rename Caso 2), abrir su ficha y confirmar que name, metalBase, acabados y QuoteIBMS quedaron exactamente como el CSV.
4. **Reporte XLSX**: validar que las 3 hojas se generan, que la cuenta del Resumen cuadra con las filas detalladas, y que los links a fichas funcionan.

## 14. Referencias

- CLAUDE.md → sección `bulk-upload 1.0.0` (estado actual, los 7 fixes existentes, el flujo de las 4 cargas)
- `remote/scripts/bulk-upload.js` líneas 653-720 (`checkPNExistence` actual)
- `remote/scripts/bulk-upload.js` líneas 549-565 (extracción de fila CSV)
- `remote/scripts/bulk-upload.js` líneas 624-650 (`mergeCustomInputs`)
- `remote/scripts/spec-migrator.js` línea 1820 (patrón de link a ficha de PN: `https://app.gosteelhead.com/PartNumbers/<id>`)
- `remote/scripts/process-deep-audit.js` (patrón de generación XLSX con SheetJS)
- `remote/config.json` → sección `steelhead.domain.bulkUpload` (a extender)
