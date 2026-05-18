# Procesos en Steelhead — Arquitectura y construcción de árboles

> Documento de referencia para todo lo que toque procesos en Steelhead: modelo de datos, mutaciones, canon, construcción del árbol para `ProcureTree`, duplicados, caches y diagnóstico. Toda lección aprendida en `process-canon` debe vivir aquí.

## 1. Modelo conceptual

Un **proceso** en Steelhead es un árbol de nodos que define el flujo productivo de una pieza desde recepción hasta embarque. Cada nodo es uno de los siguientes tipos (verificados empíricamente vía `processNodeType`):

| Tipo | Rol | Hijos típicos |
|---|---|---|
| `PROCESS` | Raíz del proceso (el "container" del proceso completo). | Top-level: SP*, T<n> Listo PP, T<n> Enracado, etc. |
| `SUB_PROCESS` | Bloque compartido reutilizable entre procesos. Ej: `SP Inspección Recibo`. | Steps internos del bloque. |
| `STEP` | Unidad de trabajo dentro de un proceso. Puede tener hijos. | STAGING, CONTRACT_REVIEW_NODE, etc. |
| `STEP_SHIPPING` | Paso terminal de embarque. | Pipeline shipping (`Ready → Invoice → Packing → Shipped`). |
| `STAGING` | Hoja: indicador de "listo para X". | — |
| `SCANNER_NODE` | Hoja: nodos `T<n> Listo Para Procesar` locales por línea. | — |
| `CONTRACT_REVIEW_NODE` | Hoja: tarea humana de revisión. | — |
| `QUALITY_ASSURANCE_NODE` | Hoja: tarea humana de QA. | — |
| `INVOICING` | Hoja: paso de facturación dentro del shipping. | — |
| `STEP_SHIPPING_READY` / `STEP_SHIPPING_PACKED` / `STEP_SHIPPING_SHIPPED` | Hojas dentro de `STEP_SHIPPING`. | — |

**Modelo de compartición.** Un nodo es "compartido" cuando su `id` aparece en varios procesos. `loadAllNodes` los descubre via `ProcessesComponentQuery` filtrando por tipos `PROCESS+SUB_PROCESS+STEP_SHIPPING`. Los `STEP` puros (como `SP Inspección Recibo`) NO entran ahí — se buscan por nombre con `searchNodeByName` que debe incluir `['PROCESS','SUB_PROCESS','STEP','STEP_SHIPPING']`.

**Convención del schema verificada (no asumir; verificar empíricamente con cada hash nuevo):**

```js
// descendantRelationships modela child → parent:
const relParentId   = (r) => r.toId;                       // PADRE
const relChildId    = (r) => r.processNodeByFromId.id;     // HIJO embed
const relChildName  = (r) => r.processNodeByFromId.name;
const relChildType  = (r) => r.processNodeByFromId.type;
// childInd ordena hermanos del mismo padre, ascendente.
```

## 2. Operaciones GraphQL relevantes

| Operación | Uso |
|---|---|
| `ProcessesComponentQuery` | Listar/paginar nodos del catálogo, filtrando por `processNodeTypes`, `includeArchived`. Devuelve `pagedData.nodes[]` con `{id, name, type, archivedAt, descendantRelationships, ...}`. |
| `AllProcesses` | Procesos top-level, paginados con `offset/first` (no `pageNumber/pageSize`). |
| `GetProcessNode` | Trae el árbol completo de UN nodo: `{treeRoot: {id, descendantRelationships[]}}`. Vars: `{id, processNodeOccurrence: 1, rootId: id}`. Inlinea descendientes embebidos. |
| `ProcureTree` (alias de `procureProcessTree2`) | Mutación que reemplaza el árbol de un proceso. Toma `{tree: {id, children, specId}}` recursivo. Devuelve `processTree` + `descendantRelationships` resultantes. |
| `CreateProcessNode` | Crea un nodo nuevo (típicamente `SCANNER_NODE` para `T<n> Listo Para Procesar`). |
| `UpdateProcessNode` | Actualiza atributos de un nodo existente (ej. `autoComplete`). Vars: `{id, autoComplete}`. Devuelve `updateProcessNodeById.clientMutationId` (puede ser `null` aunque sea exitoso — el éxito se infiere de no haber `errors`). |

## 3. Canon de 9 nodos top-level (process-canon)

El applet `process-canon` audita y aplica este patrón canónico a procesos productivos. Verificado en `T102 (EST)-AL-VARIOS` (2026-05-04):

| Pos | Nombre | Tipo | Resolución del id |
|---|---|---|---|
| 0 | `SP Inspección Recibo` | global (STEP) | `findByName(top-level) ?? lookupNodeId(name)` |
| 1 | `SP Preparación de Surtido en Almacén` | global | mismo |
| 2 | Enracado / Carga de Barril por línea | por-línea, multi-variante | `lookupSharedVariants('enracado', lineCode)[0]` |
| 3 | `T<linea> Listo para Procesar` | local SCANNER_NODE | reusar si existe; si no `CreateProcessNode` |
| 4 | Secado por línea | por-línea, multi-variante | `lookupSharedVariants('secado', lineCode)[0]` |
| 5 | Inspección y Empaque por línea | por-línea, multi-variante | `lookupSharedVariants('inspEmpaque', lineCode)[0]` |
| 6 | `SP Preparación de Embarque en Almacén` | global | `findByName ?? lookupNodeId` |
| 7 | `SP Inspección de Calidad Embarques` | global | mismo |
| 8 | `SP Embarque en Almacén` | global STEP_SHIPPING | mismo |

**Variante `(7.1)`**: el orden de slots 0 y 1 está intercambiado (primero se prepara surtido, luego se libera inspección recibo). `getPosOrder(name)` retorna `[1,0,2,3,4,5,6,7,8]` cuando matchea `/\(7\.1\)/`.

### 3.1 Identificación de la línea (tier system)

El nombre de un proceso codifica los códigos `T<NN>` y posibles sufijos `(EMT/EBT/EMR/LAV/DEC/PAS/...)`. Reglas (verificadas con casos reales):

```js
isSatelliteCode(c)   // T<n>00 (T100, T200, T500) — proceso satélite
EPOXY_SUFFIXES = {EMT, EBT, EMR}        // recubrimientos epóxicos
PREP_CODES = {T101}                     // preparación (Lavado/Decapado)
AUX_SUFFIXES = {LAV, DEC, PAS, ANT, HOR, PUL, REB, FIB, ENM, DNM}
isExcludedLineCode(c) = isSatelliteCode(c) || c === 'T401'
isExcludedProcessName(n) = /^(RT|SP)\b/i.test(n)  // retrabajos / sub-procesos
```

Tier-based resolution en `getLineCode`:
```
eligible = codes.filter(no satélite, no T401, no epóxico)
recubrimiento = eligible.filter(no T101 prep, no aux suffix)
auxiliar      = eligible.filter(no T101 prep,    aux suffix)
preparation   = eligible.filter(   T101 prep)
return pickMostFrequent(recubrimiento)
    || pickMostFrequent(auxiliar)
    || pickMostFrequent(preparation)
    || null
```

**Casos resueltos:**
- `T103 (CRD)-AC-VEEBALL (11.0)` → línea T103 (con nodo extra `T103 Limpieza Manual` permitido por subsequence matching).
- `T104 (ZIN)-T100 (HOR)-T104 (CAZ)-FE/AC-VARIOS (6.0)` → T104 (round-trip por horno).
- `T401 (EBT)-T204 (PLF)-T300 (ANT)-CU-VARIOS (16.1)` → T204 (epóxico T401 + satélite T300 excluidos).
- `T103 (LAV)-T401 (ENM)-T103 (CRD)-T401 (DNM)-T100 (FIB)-AC/INOX-VARIOS (11.0)` → T103.
- `T100 (REB)-T112 (NEL)-T109 (PAS)-T100 (HOR)-FE-VARIOS (13.2)` → T112 (Nickel Electroless gana por recubrimiento real).

### 3.2 Subsequence matching para validar orden

El proceso puede tener nodos "extra" intercalados entre los canónicos. `detectCanonStatus` valida que las posiciones canónicas aparezcan en orden creciente, NO que sean contiguas:

```js
const canonicalPosOf = (t) => {
  for (let pos = 0; pos < 9; pos++) if (slotMatchesLogical(posOrder[pos], t)) return pos;
  return null;
};
const canonicalPositions = []; const extras = [];
for (const t of topLevel) {
  const pos = canonicalPosOf(t);
  if (pos === null) extras.push(t); else canonicalPositions.push(pos);
}
// validar que canonicalPositions sea creciente estricto
```

## 4. Construcción del árbol para `ProcureTree`

**Crítico:** `ProcureTree` reemplaza el árbol completo. Espera el árbol **expandido hasta hojas reales** — NO un árbol plano (rootId con un solo nivel de hojas) y NO se resuelven sub-árboles desde el catálogo automáticamente.

### 4.1 Shape esperado por ProcureTree

Capturado del UI 2026-05-05 al agregar manualmente `SP Inspección Recibo` a un proceso TEST (id 221573):

```json
{
  "id": 221573,
  "specId": null,
  "children": [
    { "id": 139820, "specId": null, "children": [
        { "id": 231174, "specId": null, "children": [
            { "id": 231175, "specId": null, "children": [] },
            { "id": 231176, "specId": null, "children": [] }
        ] },
        { "id": 166805, "specId": null, "children": [] },
        { "id": 166806, "specId": null, "children": [] }
    ] },
    { "id": 221574, "specId": null, "children": [] },
    { "id": 221576, "specId": null, "children": [
        { "id": 221577, "specId": null, "children": [] },
        { "id": 221580, "specId": null, "children": [] },
        { "id": 221578, "specId": null, "children": [] },
        { "id": 221579, "specId": null, "children": [] }
    ] }
  ]
}
```

Observaciones:
- Cada referencia a un compartido (`139820 = SP Inspección Recibo` SUB_PROCESS, `221576 = Ship` STEP_SHIPPING) viaja con su sub-árbol del catálogo.
- Hasta hojas reales (`STAGING`, `CONTRACT_REVIEW_NODE`, `QUALITY_ASSURANCE_NODE`, `INVOICING`, `STEP_SHIPPING_*`).
- STEPs simples sin sub-árbol (`221574 = Processing`, type STEP) viajan como hojas vacías.
- TODO nodo lleva `specId: null` explícito (el UI lo manda incluso para nodos sin spec asociada).

### 4.2 Síntoma de input plano incorrecto

```
GraphQL errors (ProcureTree): [1] In checkTrees,
expected node id=139820 to have 0 children, but found 3
```

Lectura: "tu input dice 0 hijos para 139820, pero el catálogo dice que tiene 3. Reproduce esos 3 (con sus sub-árboles)." NO se interpreta como "manda 0 hijos" — al contrario, es el server pidiendo el sub-árbol expandido.

### 4.3 De dónde sale el sub-árbol

Dos fuentes complementarias:

1. **Compartidos preexistentes en el proceso.** `fetchProcessTree(processId)` devuelve `treeRoot.descendantRelationships[]` que YA inlinea los rels del catálogo de los compartidos referenciados. Indexar como `byParent: Map<parentId, rel[]>` y recursar sobre top-level.

2. **Compartidos que el applet inserta nuevos.** Si vamos a meter un compartido al proceso que aún no estaba (ej. canon dice "agregar SP Inspección Recibo" pero el proceso no lo tenía), su sub-árbol del catálogo NO está en `allRels` del proceso. Hay que fetchar `GetProcessNode(sharedId)` aparte y agregar sus rels al pool antes de recursar.

Patrón en `process-canon.js`:

```js
// Cache global por id (compartidos se reúsan en cientos de procesos).
const _subtreeRelsCache = new Map();
async function fetchSubtreeRels(rootId) {
  if (_subtreeRelsCache.has(rootId)) return _subtreeRelsCache.get(rootId);
  const tree = await fetchProcessTree(rootId);
  const rels = tree?.descendantRelationships || [];
  _subtreeRelsCache.set(rootId, rels);
  return rels;
}

async function ensureSharedRels(byParent, allRels, ids) {
  for (const id of ids) {
    if (byParent.has(id)) continue; // proceso ya lo tenía → sus rels ya están en allRels
    const rels = await fetchSubtreeRels(id);
    for (const r of rels) {
      allRels.push(r);
      const p = relParentId(r);
      if (p == null) continue;
      if (!byParent.has(p)) byParent.set(p, []);
      byParent.get(p).push(r);
    }
  }
}

function buildNewTree(rootId, canonicalIds, extraIds, allRels) {
  const byParent = new Map();
  for (const r of allRels) {
    const p = relParentId(r);
    if (p == null) continue;
    if (!byParent.has(p)) byParent.set(p, []);
    byParent.get(p).push(r);
  }
  const visited = new Set([rootId]);
  function buildSubtree(nodeId) {
    if (visited.has(nodeId)) return { id: nodeId, children: [], specId: null };
    visited.add(nodeId);
    const childRels = (byParent.get(nodeId) || []).slice()
      .sort((a, b) => (a.childInd || 0) - (b.childInd || 0));
    const children = [];
    for (const r of childRels) {
      const cid = relChildId(r);
      if (cid == null) continue;
      const sub = buildSubtree(cid);
      if (r.specId !== undefined) sub.specId = r.specId ?? null;
      children.push(sub);
    }
    return { id: nodeId, children, specId: null };
  }
  const childrenAll = [...canonicalIds, ...extraIds].map(id => buildSubtree(id));
  return { id: rootId, children: childrenAll, specId: null };
}
```

## 5. Duplicados activos y resolución de ids

`ProcessesComponentQuery` con `includeArchived: 'NO'` aún devuelve múltiples nodos activos con el mismo nombre. Caso real (log 2026-05-05): `SP Embarque en Almacén` aparece 7 veces activo: `[109804, 191500, 191794, 200037, 200083, ...]`.

**Regla de resolución (process-canon 0.5.54):** para los 5 globales del canon, **PREFERIR el id que el proceso ya tiene en su top-level** (matched por nombre normalizado) sobre el del catálogo. Razón: si usas el id del catálogo cuando el proceso referencia uno distinto, el id viejo del proceso queda como "extra" y termina referenciado dos veces, rompiendo `checkTrees`.

```js
const findByName = (canonicalName) => {
  const norm = normName(canonicalName);
  const t = topLevelFresh.find(x => normName(x.name) === norm);
  return t ? t.id : null;
};
const idInsRecibo = findByName('SP Inspección Recibo') || lookupNodeId('SP Inspección Recibo');
```

`normName` decompone NFD + remueve diacríticos + lowercase + trim, así "Inspección" ≡ "Inspeccion".

**Filtro client-side de archivados (process-canon 0.5.47).** El server no siempre honra `includeArchived: 'NO'`. Reforzar con:
```js
function isArchivedNode(n) {
  return n?.archive === true || n?.isArchived === true ||
    (n?.archivedAt != null && n.archivedAt !== '') ||
    (n?.archivedDate != null && n.archivedDate !== '');
}
```

## 6. Discovery de compartidos por línea (tag-based)

Las variantes de Enracado/Secado/Inspección y Empaque viven taggeadas en Steelhead. Patrón en `loadSharedByLine`:

1. Localizar el tag de cada operación por nombre (`enracado`, `secado`, `inspEmpaque`).
2. Paginar `ProcessesWithTag` con `offset/first`.
3. Por cada nodo, extraer `lineCode = /^(T\d{2,4}|M\d{2,4})\b/i.exec(name)[1].toUpperCase()`.
4. Construir `Map<lineCode, Array<{id, name}>>` — una línea puede tener varias variantes en un mismo tag.

Ejemplo: T102 tiene `Secando Manual – Desenracado` Y `Secando Centrífugo` bajo el tag de Secado. Cada proceso usa la suya. La detección acepta CUALQUIER variante del Set.

`pickLineId(op, posIdx)` para reuso:
1. Si el proceso ya tiene una variante válida en la posición → preservarla.
2. Si el proceso tiene CUALQUIER variante válida en otra posición → preservarla.
3. Si no tiene ninguna → default = primera variante del Set.

Esto evita "T102 (EST) usa Centrífugo" → forzarlo a Manual.

## 7. Diagnóstico — playbook

Cuando un endpoint de Steelhead se comporta inesperado, captura el request real del UI en lugar de iterar a ciegas:

1. **Reproducir manualmente en el UI.** Si la op es "agregar nodo X a proceso Y", ejecuta esa acción manualmente.
2. **DevTools → Network → filtrar por `graphql`, "Preserve log".** Encuentra el request con el `operationName` correcto.
3. **Copiar el body**: click derecho → Copy → Copy as cURL (bash). El payload JSON completo (incluyendo el shape recursivo del input) está en `--data-raw`.
4. **Comparar con lo que envías**. Diferencias críticas suelen estar en:
   - Estructura recursiva (plano vs expandido).
   - Campos opcionales que el UI sí envía explícitos (ej. `specId: null`).
   - Tipos (string vs number en quantity/price; ver Portal Importer).
   - `operationName` (a veces el UI usa una mutación distinta a la que pensabas).

**Lección meta (process-canon 0.5.51 → 0.5.56):** las versiones 0.5.52, 0.5.53, 0.5.54, 0.5.55 fueron parches a ciegas adivinando el shape. La 0.5.56 fue post-captura del request del UI → fix correcto en una iteración. **Siempre captura primero**.

## 8. Telemetría para deploys remotos

La extensión carga scripts desde GitHub Pages con cache-bust en `config.version`. Para confirmar la versión cargada sin tener que ir a `chrome://extensions`:

```js
// Al final del módulo:
if (typeof window !== 'undefined') {
  window.YourApplet = YourApplet;
  window.__yaVersion = '0.5.56';
  try { console.log('[SA] your-applet cargado · v0.5.56'); } catch (_) {}
}
```

Y para diagnóstico de mutaciones complejas:

```js
try { window.__lastProcureTreeInput = newTree; } catch (_) {}
log(`  ${process.name}: ProcureTree input → root=${process.id}, canonical=[${canonicalIds.join(',')}], extras=[${extraIds.join(',') || '∅'}]`);
```

El usuario puede pegar `JSON.stringify(window.__lastProcureTreeInput, null, 2)` cuando algo falla, sin tener que activar Network.

## 9. Glosario de versiones (process-canon)

| Versión | Cambio | Lección |
|---|---|---|
| 0.5.39 | Normaliza tildes + amplía types + diagnostic UI | Schema fields varían por tipo de query. |
| 0.5.40 | Discovery por `ProcessesComponentQuery` + prefijo "SP" | El catálogo principal es `ProcessesComponentQuery`, no `AllProcesses`. |
| 0.5.41 | Canon real es de 9 nodos, no 10 — colapsar Preparación/Embarque | Pedir wireframes/casos reales antes de codificar el canon. |
| 0.5.42 | Discovery por tag para compartidos por línea | Multi-variante por línea, no único por línea. |
| 0.5.43 | Cargar `SCANNER_NODE` para resolver `name` de Listo PP + heurística lineCode | Tipos extra que `loadAllNodes` no capta hay que cargarlos por separado. |
| 0.5.47 | Filtro client-side de archivados | El server no siempre honra `includeArchived: 'NO'`. |
| 0.5.48 | Subsequence matching + variante `(7.1)` | Procesos legítimos pueden tener nodos extra intercalados. |
| 0.5.49 | Heurística por frecuencia para línea (T104-T100-T104) | Round-trip por horno = línea de inicio/regreso. |
| 0.5.50 | Tier system (epóxicos / satélites / preparation) | Una línea puede tener varios códigos T<n>; jerarquía resuelve cuál es la "línea oficial". |
| 0.5.51 | Sufijos auxiliares + RT/SP excluidos + estado "no aplica canon" | Sufijos `(EMT/EBT/EMR/LAV/DEC/...)` modifican la jerarquía; RT y SP son retrabajos/subprocesos. |
| 0.5.52–0.5.55 | Intentos a ciegas de fix ProcureTree (set `_sharedIds`, plano, prefer-existing-id) | **Inutiles**: capturar el request del UI primero. |
| 0.5.56 | `ensureSharedRels` + `buildNewTree` recursivo con sub-árboles del catálogo | ProcureTree espera árbol completo expandido hasta hojas reales. |
| 0.5.59 | Marcar el nodo raíz del proceso como `autoComplete: true` vía `UpdateProcessNode` después del `ProcureTree` exitoso | `ProcureTree` no expone `autoComplete` en el shape del árbol (capturado del UI 2026-05-05); es una mutación aparte sobre el nodo raíz. La llamada se trata como **post-step tolerante a fallos**: si 502/red revientan, el run sigue como éxito (el canon ya quedó aplicado) y se reporta `autoCompleteSet: false` en el resultado. Lección meta: **NO adivinar el shape** — antes de agregar la llamada se capturó el cURL del UI para confirmar `operationName`, hash y variables `{id, autoComplete}`. |
| 0.8.0 (deep-audit) | Detección de duplicados D1/D2/D3 sobre PROCESS+SUB_PROCESS+STEP_SHIPPING+satélites+RT con 3 hojas XLSX + Leyenda + título mergeado. Canónico por id+parents; AccionSugerida_NUEVO editable. | `evaluateD` reusa caché `state.treesById` de R1-R4 para minimizar HTTP. Pool separado para árboles faltantes y `getProcessNodeParents`. |

## 10. Treatments, stations y tiempos (process-deep-audit)

Modelo confirmado al construir `process-deep-audit` (v0.7.0) con `scan_results_2026-05-15_182824.json`:

```
Treatment
  ├─ id, name
  └─ stationTreatmentsByTreatmentId.nodes[]
       ├─ id (StationTreatment.id, sin relación con Station)
       ├─ stationId
       └─ stationByStationId { id, name }

TreatmentTime (consulta por sets de ids)
  ├─ cycleTime  { hours, minutes, seconds }
  ├─ totalTime  { hours, minutes, seconds }
  ├─ timeType   ('FIXED' | 'PER_PART' | …)
  ├─ stationByStationId       { id, name }
  ├─ treatmentByTreatmentId   { id, name }
  └─ processNodeByProcessNodeId { id, name } | null
```

Diferencia clave: las `TreatmentTime` viven en una tabla separada y se consultan vía
`CreateEditTreatmentTimesDialogQuery` pasando un set de combinaciones:
- `searchTreatmentTimesInput`: `[{stationId, treatmentId, processNodeOccurrence}]`
- `partNumberIds`: `[]` (todos)
- `treatmentIds`, `stationIds`, `processNodeIds`: pueden venir como arrays de filtro
- `treatmentGroupIds`: `[]` cuando no usas grouping

La respuesta indexa por `allRelatedTreatmentTimesByIdSets.nodes[].relatedTimes[]`. Una
estación puede tener tiempos genéricos (`processNodeByProcessNodeId === null`) o
específicos por nodo del proceso, e incluso por ocurrencia (`processNodeOccurrence`).
Para auditar "¿tiene tiempos cargados?" basta con verificar que **alguna** entrada de
`relatedTimes` tenga `intervalToSeconds(cycleTime) > 0` para la estación.

Ops nuevas en config (`steelhead.hashes.queries`):
- `GetTreatment` — detalle de un treatment con estaciones embebidas.
- `AllTreatments` — listado paginado de treatments con estaciones.
- `CreateEditTreatmentTimesDialogQuery` — tiempos para sets de ids (la que sí necesitas
  para auditar tiempos cargados).
- `StationsByTreatmentId` — estaciones de un treatment dado (fallback ligero).
- `GetProcessNodeParents` — devuelve `parentProcesses.nodes[]` del nodo. Usado para
  detectar si un satélite (`T100`, `T200`, …) está **compartido en uso** por varios
  procesos.
- `CreateEditProcessDialogQuery` — detalle ligero (sin árbol) del proceso para R4:
  `defaultLeadTime{hours,minutes,seconds}`, `productByProductId{id,name}`, y conteo de tags.

### 10.1 `process-deep-audit` (v0.7.0) — alcance y reglas

Applet hermano de `process-canon`, **read-only**, que genera un reporte + plantilla
XLSX con columnas editables para futura carga masiva. Comparte el catálogo y las
queries vía `process-shared.js` (cargado antes que `process-canon.js` y
`process-deep-audit.js` en el `apps[].scripts[]` de `config.json`).

Reglas evaluadas por proceso:

- **R1 — "Listo para Procesar" con tipo inválido.** Cualquier nodo del árbol cuyo
  nombre matchee `/Listo/i` y cuyo `type ∉ {SCANNER_NODE, STAGING, STEP_SHIPPING_READY}`
  se reporta como candidato a fix estructural. **`STEP_SHIPPING_READY` es válido
  por diseño** — es el tipo especial que llevan los nodos "Listo" del flujo de
  embarques; no debe reportarse como problema (corrección 0.7.1).
- **R2 — Tiempos por sección (línea principal).** Por cada bloque T<n> detectado en
  top-level (`PS.detectLineSections`):
  1. Localizar el nodo Listo del bloque (en el árbol expandido).
  2. `GetProcessNode(listoId).processNodeById.treatmentByTreatmentId` — si null →
     `R2-a Sin treatment asignado`.
  3. `GetTreatment(treatmentId)` — si `stationTreatmentsByTreatmentId.totalCount === 0`
     → `R2-b Sin estaciones`.
  4. `CreateEditTreatmentTimesDialogQuery({treatmentIds, stationIds, processNodeIds:[listoId]})`
     — si ninguna entrada tiene `cycleTime > 0` → `R2-c Sin tiempos`. Tiempos parciales
     (algunas estaciones sí, otras no) → `R2-d Parcial`.
- **R3 — Satélites con tiempos.** Catálogo híbrido: descubrimiento por regex
  (`SATELLITE_REGEX`), sufijos auxiliares (`FIB`, `ANT`, `HOR`, `LIM`, `VIB`, etc.) e
  `include`/`exclude` desde `config.json:steelhead.domain.processAudit.satelliteOverrides`.
  Cada satélite se trata como un mini-proceso: valida que tenga treatment con estaciones
  y tiempos > 0. `GetProcessNodeParents` reporta si el satélite está **compartido en
  uso** (varios procesos lo referencian).
- **R4 — Lead time + producto.** Por cada `PROCESS` root (incluye satélites):
  - `defaultLeadTime` con todos los componentes en 0 → `R4-a Sin lead time`.
  - `productByProductId` null → `R4-b Sin producto`.
  - Sufijos del nombre (`(EST)`, `(NIQ)`, …) que no estén cubiertos por tokens del
    `productByProductId.name` según `finishProductMap` → `R4-c Producto no cubre acabado`.

Salida: `process-deep-audit-<YYYY-MM-DD>.xlsx` con 6 hojas (`Resumen`, `R1_Listo_NoScanner`,
`R2_TiemposLineaPrincipal`, `R3_Satélites`, `R4_LeadTime_Producto`, `Catálogos`),
incluyendo columnas `*_NUEVO` editables que un applet hermano de Fase 2 leerá para hacer
las mutaciones de carga masiva. Adicionalmente se ofrece export JSON crudo para diffs
entre corridas.

Concurrencia: pool de 5 procesos en paralelo (`steelhead.domain.processAudit.concurrency`).
Retries con backoff `retryDelaysMs: [0, 1000, 2000]` por proceso. Cancelación con patrón
`runId` + `isStale()` (mismo de `invoice-autofill`).

## 11. Pendientes / áreas para extender

- **Cache persistente de `_subtreeRelsCache`.** Hoy se reinstancia por sesión del applet. Si el procesamiento de cientos de procesos repite lookups, considera mover el cache a `chrome.storage.local` con TTL.
- **Detección de cambio en el catálogo.** Si Steelhead actualiza un sub-árbol shared (ej. agrega un step nuevo a `SP Inspección Recibo`), el cache lo deja stale. Estrategia: invalidar al inicio de cada sesión del applet, o fingerprint vía hash del árbol.
- **Reducir duplicados activos.** El log "SP Embarque en Almacén tiene 7 duplicados ACTIVOS" sugiere drift en el catálogo. No es responsabilidad del applet limpiarlo, pero documentar el caso ayuda al equipo de operaciones.
- **`extension/background.js:212` (`get-current-user`).** Sigue invocando `CurrentUser` deprecado (ver lección de v0.5.7 en `CLAUDE.md`). Pivotar a `CurrentUserDetails`.

## 12. Detección de duplicados (process-deep-audit ≥ v0.8.0)

`process-deep-audit` corre tres firmas de duplicado sobre un universo unificado
(PROCESS principales + satélites + RT + SUB_PROCESS + STEP_SHIPPING) después de
R1-R4. Read-only: emite tres hojas XLSX (D1, D2, D3) con `AccionSugerida_NUEVO`
editable para que un applet de Fase 2 procese decisiones de archivado/fusión.

### 12.1 Firmas

- **D1 — `signatureD1(node)` = `normName(name)`.** Detecta drift puro del catálogo
  (ej. los 7 IDs activos de `SP Embarque en Almacén`).
- **D2 — `signatureD2(treeRoot)` = `JSON.stringify(extractTopLevel(treeRoot).map(c => c.id))`.**
  Detecta procesos que reusan exactamente los mismos hijos directos en el mismo orden.
- **D3 — `signatureD3(treeRoot)` = `JSON.stringify(extractTopLevel(treeRoot).map(c => normName(c.name)))`.**
  Detecta clones por "Save As..." donde los nombres top-level son idénticos pero los
  IDs distintos. Caso más común dado los duplicados activos de SUB_PROCESS.

Profundidad: D3 mira solo top-level. Razones documentadas en el spec
`docs/superpowers/specs/2026-05-18-process-duplicates-design.md`. Si la corrida
real revela necesidad de full-depth, agregar D4 con datos.

### 12.2 Canónico

```js
function pickCanonical(members, parentsByIdCache) {
  return members.slice().sort((a, b) => {
    const pa = parentsByIdCache.get(a.id);
    const pb = parentsByIdCache.get(b.id);
    const fa = (pa == null) ? -1 : pa;
    const fb = (pb == null) ? -1 : pb;
    if (fa !== fb) return fb - fa;  // más referencias gana
    return a.id - b.id;              // empate → id más bajo gana
  })[0];
}
```

`parentsByIdCache` se llena con `getProcessNodeParents(id)` SOLO para miembros de
grupos con `size ≥ 2`. Para nodos sin dato (502, cancelación), `pickCanonical` los
trata como `-1` → pierden contra cualquier número.

`AccionSugerida` automática:
- `EsCanonico=true` → `MANTENER`
- `EsCanonico=false && refs=0` → `ARCHIVAR`
- `EsCanonico=false && refs>0` → `FUSIONAR`
- `refs` desconocido → vacío

### 12.3 Universo y filtros

`buildAuditUniverse(allProcesses, satelliteCatalog)` reúne los 5 buckets:

- `main` — PROCESS sin prefijo RT/SP, no satélite.
- `satellite` — del catálogo R3.
- `rt` — PROCESS con `/^RT\b/i`.
- `subprocess` — SUB_PROCESS del catálogo `loadAllNodes`.
- `stepshipping` — STEP_SHIPPING del catálogo.

Filtros desde `config.json:steelhead.domain.processAudit.duplicates`:
- `enabled: false` salta toda la fase.
- `includeSources: [...]` permite limitar a subconjuntos.
- `ignoreIds: [int]` excluye IDs específicos.
- `ignoreNamePatterns: ["regex"]` excluye por nombre (regex case-insensitive).

### 12.4 Cache `state.treesById`

Para evitar `getProcessTree` duplicado, `auditProcess` y `evaluateR3` (R1-R4)
guardan su árbol fetched en `state.treesById: Map<id, {treeRoot, processNodeById}>`.
`evaluateD` reusa lo cacheado y solo dispara fetch para los faltantes
(`auditUniverse \ treesById.keys`), típicamente SUB_PROCESS/STEP_SHIPPING/RT.

Pool separado: `processAudit.concurrency.trees` (default 5) para árboles faltantes,
`processAudit.concurrency.parents` (default 5) para `getProcessNodeParents`.

### 12.5 Cancelación parcial

Si el usuario cancela durante el fetch de árboles faltantes:
- D1 (que no depende del árbol) emite completo.
- D2/D3 se construyen con los árboles que sí se tienen.
- `state.duplicates.partial = true`.
- Panel marca `[PARCIAL]`, hoja Resumen muestra `NotaParcial = "PARCIAL_POR_CANCELACION"`.

Sin requests colgados; el pool drena pendientes ya iniciados pero no encola más.

### 12.6 Pendientes

- **Fase 2 — applet hermano.** Lee el XLSX editado con `AccionSugerida_NUEVO ∈ {ARCHIVAR, FUSIONAR, MANTENER}` y aplica las mutaciones. Para `FUSIONAR` requiere re-apuntar referencias entrantes al canon antes de archivar (mutation `ArchiveProcessNode` o equivalente — no investigado aún).
- **D4 full-depth.** Si D3 top-level resulta insuficiente, recursar firmas. Requiere `flattenTree` enriquecido y costo recursivo controlado.
- **Detección incremental.** Hoy cada corrida es desde cero. Persistir el último resultado en `chrome.storage.local` permitiría reportar "nuevos grupos vs corrida anterior".
