# Detección de duplicados en el canon de procesos — Diseño

**Fecha:** 2026-05-18
**Applet objetivo:** `process-deep-audit` (extiende v0.7.1 → v0.8.0)
**Tipo:** Feature read-only (auditoría + reporte XLSX). Sin mutaciones.
**Autor del brief:** oviazcan@gmail.com

## 1. Problema

El catálogo de procesos de Steelhead acumula drift: nodos con el mismo nombre creados accidentalmente (ej. `SP Embarque en Almacén` con 7 IDs activos confirmados en log de v0.7.0), y procesos productivos clonados por copia "Save As..." que terminan con árboles equivalentes pero IDs distintos. Hoy no hay forma sistemática de detectarlos. `process-canon` solo loggea duplicados de los 5 GLOBALS canónicos al cargar el catálogo; no produce reporte y no cubre PROCESS principales, satélites, retrabajos ni el resto de SUB_PROCESS/STEP_SHIPPING.

## 2. Alcance

**Dentro:**
- Detectar duplicados sobre el universo: PROCESS principales, satélites (T100/T200/...), SUB_PROCESS, STEP_SHIPPING, retrabajos (prefijo RT).
- Tres criterios de duplicación en paralelo (D1, D2, D3 — ver §4).
- Excluir nodos archivados (mismo criterio que `loadAllNodes` hoy).
- Determinar el "canónico" del grupo por heurística (ID + referencias entrantes).
- Generar 3 hojas XLSX nuevas + leyenda + cross-flags entre criterios.
- Tolerancia a 502/red individuales (mismo patrón que R2/R3/R4).
- Cancelación responsiva (mismo `runId`+`isStale`).
- Canal de escape por config (`ignoreNamePatterns`, `ignoreIds`).

**Fuera:**
- Mutaciones de archivado/fusión (Fase 2 con applet hermano que lee `AccionSugerida_NUEVO`).
- Detección recursiva full-depth (D3 cubre solo top-level; D4 si la corrida real lo justifica).
- UI in-page sin descargar XLSX (panel solo muestra conteo).
- Notificación automática cuando aparezca un grupo nuevo (requiere persistencia entre corridas — fuera).

## 3. Arquitectura — dónde vive

**Regla nueva R5 ("Duplicados D1/D2/D3") dentro de `process-deep-audit`.** Reusa loaders (`loadAllNodes`, `fetchAllProcesses`), pool concurrente, panel, cancelación y motor XLSX existentes. Bump 0.7.1 → 0.8.0.

```
process-deep-audit v0.8.0
  ├─ R1, R2, R3, R4 — sin cambios funcionales
  ├─ ★ D1, D2, D3 — nueva fase global post-R4
  └─ XLSX: 9 hojas (Leyenda, Resumen, R1..R4, D1..D3, Catálogos)

Pipeline:
  1. loadAllNodes + loadScannerNodes + fetchAllProcesses
  2. R1+R2+R4 sobre mainProcesses     ──┐
  3. R3 sobre satélites                ──┼─► alimentan state.treesById (caché)
  4. Fetch árboles faltantes (SUB_PROCESS, STEP_SHIPPING, RT)
  5. evaluateD: groupBySignature × 3
  6. Resolver canónico (getProcessNodeParents en grupos size≥2)
  7. Resumen + Catálogos + XLSX
```

Decisión rechazada: applet hermano separado (`process-dup-detect`). Razón: duplicaría loaders, panel y XLSX. La detección se ejecuta a la misma cadencia que la auditoría profunda y comparte el grueso de los datos.

Decisión rechazada: sección en `process-canon`. Razón: `process-canon` es interactivo (aplica canon a UN proceso, mutating). La detección de duplicados es global y read-only.

## 4. Componentes y firmas

### 4.1 Universo a analizar

```js
auditUniverse = [
  ...mainProcesses,    // PROCESS top-level (excluye RT/SP/satélite)
  ...satelliteCatalog, // PROCESS satélite
  ...rtProcesses,      // PROCESS con prefijo RT
  ...subProcesses,     // SUB_PROCESS del catálogo
  ...stepShippings     // STEP_SHIPPING del catálogo
]
```

Cada item: `{id, name, type, source}` donde `source ∈ {'main','satellite','rt','subprocess','stepshipping'}`. `source` es solo metadata para el reporte — un PROCESS con árbol idéntico a un SUB_PROCESS sí cuenta como duplicado (D2/D3) y es útil para encontrar promociones accidentales.

Archivados excluidos por `isArchivedNode` (mismo criterio que `loadAllNodes`).

### 4.2 Firma D1 — mismo nombre normalizado

```js
sigD1(node) = ProcessShared.normName(node.name)
// "SP Embarque en Almacén" → "sp embarque en almacen"
```

Coste: cero HTTP (solo memoria). Captura: drift puro del catálogo.

### 4.3 Firma D2 — mismo tren de IDs top-level

```js
sigD2(treeRoot) = JSON.stringify(
  ProcessShared.extractTopLevel(treeRoot).map(c => c.id)
)
// → "[139820,221574,221576]"
```

Captura: procesos que reusan exactamente los mismos hijos directos en el mismo orden. Útil para detectar templates compartidos.

### 4.4 Firma D3 — mismo tren de nombres top-level normalizados

```js
sigD3(treeRoot) = JSON.stringify(
  ProcessShared.extractTopLevel(treeRoot).map(c => ProcessShared.normName(c.name))
)
// → "[\"sp inspeccion recibo\",\"t102 listo para procesar\",\"ship\"]"
```

Captura: clones por Save As... donde alguien recreó nodos con mismo nombre pero IDs nuevos. **Caso más común** dado los 7 duplicados activos de `SP Embarque en Almacén`.

**Decisión de profundidad:** D3 mira solo top-level. Razones: (a) los compartidos están casi siempre en top-level del PROCESS y los duplicados aparecen ahí; (b) recursar full-depth multiplicaría el costo por ~10x sin ganancia detectable inicial; (c) D3 cruza con D1 (los compartidos duplicados aparecen también en D1). Si la auditoría real revela necesidad, se diseña D4 después con datos.

### 4.5 Canónico del grupo

```js
function pickCanonical(members, parentsByIdCache) {
  return members.slice().sort((a, b) => {
    const pa = parentsByIdCache.get(a.id) ?? 0;
    const pb = parentsByIdCache.get(b.id) ?? 0;
    if (pa !== pb) return pb - pa;   // más referencias gana
    return a.id - b.id;              // empate → id más bajo gana
  })[0];
}
```

`parentsByIdCache: Map<id, number>` se llena vía `ps().getProcessNodeParents(id)` SOLO para miembros de grupos con `size ≥ 2`. Pool de 5 paralelas, retries `[0, 1000, 2000]` ms.

### 4.6 Funciones nuevas

**`process-shared.js`:**

```js
ProcessShared.signatureD1(node)              // → normName(name)
ProcessShared.signatureD2(treeRoot)          // → "[id,id,...]"
ProcessShared.signatureD3(treeRoot)          // → "[\"name\",\"name\",...]"
ProcessShared.groupBySignature(items, sigFn) // → Map<sig, item[]>
```

Bump `window.__psVersion = '0.8.0'`.

**`process-deep-audit.js`:**

```js
async function evaluateD(auditUniverse, treesById, myRunId)
  // → { d1, d2, d3, parentsByIdCache }
```

Bump `VERSION = '0.8.0'`.

## 5. Flujo de datos y rendimiento

### 5.1 Caché `state.treesById`

Hoy `auditProcess` hace `getProcessTree(p.id)` y descarta el resultado. Cambio mínimo:

```js
state.treesById = new Map();   // Map<processId, {treeRoot, processNodeById}>

// dentro de auditProcess (sin otros cambios)
const tree = await withRetry(() => ps().getProcessTree(p.id), ...);
state.treesById.set(p.id, tree);   // ★ guardar para D2/D3
```

Mismo cambio en `evaluateR3` (que también llama `getProcessTree` para satélites).

Después de R1-R4, `treesById` tiene ~330 árboles sin un solo HTTP adicional. Faltantes:
- ~30 SUB_PROCESS
- ~10 STEP_SHIPPING
- ~15 RT (estimado)

→ ~55 árboles extra + 30-50 `getProcessNodeParents`. A 5 paralelas, ~300ms por request: **~10-15s extra sobre el run actual** (~3-5 min total).

### 5.2 Pool concurrente

```js
// Fetch árboles faltantes
runPool(missingTrees, async (node) => {
  const tree = await withRetry(() => ps().getProcessTree(node.id), `dup tree ${node.id}`, myRunId);
  state.treesById.set(node.id, tree);
}, concurrency, progressFn, myRunId);

// Cómputo in-memory de firmas
const groupsD1 = groupBySignature(auditUniverse, sigD1);
const groupsD2 = groupBySignature(auditUniverse, n => sigD2(state.treesById.get(n.id)?.treeRoot));
const groupsD3 = groupBySignature(auditUniverse, n => sigD3(state.treesById.get(n.id)?.treeRoot));

// Filtrar size≥2, recolectar allDupIds, fetch parents
runPool(allDupIds, async (id) => {
  const parents = await ps().getProcessNodeParents(id);
  parentsByIdCache.set(id, parents.length);
}, concurrency, progressFn, myRunId);
```

`concurrency` viene de `auditConcurrency()`: nuevos campos `trees: 5` y `parents: 5` en config (default 5 si faltan).

### 5.3 Cancelación

- Antes de cada `runPool`: `bailIfStale(myRunId)`.
- Dentro del callback: `if (state.cancelled || isStale(myRunId)) return;`.
- Durante `groupBySignature`: chequeo cada 100 iteraciones (defensa; el cómputo es muy rápido).
- Si se cancela durante el fetch de árboles faltantes: D1 sí completa (no necesita árbol), D2/D3 se emiten con los árboles que sí se tienen + marca `PARCIAL_POR_CANCELACION` en Resumen.

### 5.4 Errores individuales

- `getProcessTree` falla 3 veces para un nodo → nodo omitido de D2/D3, sigue en D1. Fila en `state.errors`.
- `getProcessNodeParents` falla → `ReferenciasEntr.` queda vacío, `AccionSugerida` también. Resto del grupo sigue normal.

## 6. UI y reporte

### 6.1 Panel (afecta también a R1-R4 existentes)

Hoy el panel muestra labels crípticos. Cambio:

```
┌─ 🔬 Auditoría Profunda de Procesos · v0.8.0 ──────────────────┐
│                                                                │
│  Reglas estructurales                                          │
│  ▸ R1 — "Listo" con tipo incorrecto         [12 hallazgos]    │
│  ▸ R2 — Tiempos por sección/línea            [34 hallazgos]    │
│  ▸ R3 — Satélites con tiempos cargados       [ 8 hallazgos]    │
│  ▸ R4 — Lead time + producto coherente       [17 hallazgos]    │
│                                                                │
│  Duplicados ★ NUEVO                                            │
│  ▸ D1 — Mismo nombre (catálogo drift)        [ 9 grupos / 22] │
│  ▸ D2 — Mismo tren de IDs top-level          [ 4 grupos /  9] │
│  ▸ D3 — Mismo tren de nombres top-level      [11 grupos / 27] │
│                                                                │
│  [Detener] [Descargar XLSX] [Descargar JSON]                   │
└────────────────────────────────────────────────────────────────┘
```

Tooltip en hover de cada sigla con el detalle del subcaso. Conteo separado `grupos / miembros totales` para las D.

### 6.2 XLSX — hojas

Orden de hojas:

1. **`Leyenda`** (NUEVA) — tabla `Sigla | Descripción | Subcaso | Estado posible | Acción típica`. Un solo lugar de verdad para QA/Producción.
2. **`Resumen`** — agrega columnas `Duplicados_D1`, `Duplicados_D2`, `Duplicados_D3` (conteo por proceso) + flag `PARCIAL_POR_CANCELACION` global si aplica.
3. **`R1_Listo_NoScanner`**
4. **`R2_TiemposLineaPrincipal`**
5. **`R3_Satélites`**
6. **`R4_LeadTime_Producto`**
7. **`D1_DuplicadoNombre`** (NUEVA)
8. **`D2_DuplicadoTrenIDs`** (NUEVA)
9. **`D3_DuplicadoTrenNombres`** (NUEVA)
10. **`Catálogos`**

**Cada hoja** (incluyendo R1-R4 existentes en este bump) gana **fila 1 con título mergeado** A1:N1 con la descripción completa, ej.:

```
"D1 — Mismo nombre (catálogo drift). Nodos activos distintos con el mismo
 nombre normalizado. Indica copias accidentales del catálogo."
```

Headers de columna en fila 2; datos desde fila 3.

### 6.3 Columnas de las hojas D1/D2/D3

| Columna | Ejemplo |
|---|---|
| `ProcessID` | 109804 |
| `ProcessName` | SP Embarque en Almacén |
| `Tipo` | STEP_SHIPPING |
| `Source` | stepshipping |
| `GrupoID` | "sp embarque en almacen" (D1) · "[139820,221574,221576]" (D2) · "[\"sp inspeccion...\"]" (D3) |
| `GrupoTamano` | 7 |
| `EsCanonico` | true / false |
| `ReferenciasEntrantes` | 142 (vacío si fetch falló) |
| `EsArchivado` | false (siempre, por filtro) |
| `TambienEnD1` | true |
| `TambienEnD2` | false |
| `TambienEnD3` | true |
| `AccionSugerida` | "MANTENER" / "ARCHIVAR" / "FUSIONAR" / "" |
| `AccionSugerida_NUEVO` | (vacía, editable por operador) |
| `Notas_NUEVO` | (vacía) |

Reglas automáticas de `AccionSugerida`:
- `EsCanonico=true` → `"MANTENER"`.
- `EsCanonico=false` y `ReferenciasEntrantes=0` → `"ARCHIVAR"`.
- `EsCanonico=false` y `ReferenciasEntrantes>0` → `"FUSIONAR"` (re-apuntar antes de archivar).
- Vacía si `ReferenciasEntrantes` quedó vacío por error.

## 7. Configuración

Cambios en `remote/config.json`:

```jsonc
{
  "version": "0.8.0",
  "lastUpdated": "2026-05-18",
  "steelhead": {
    "domain": {
      "processAudit": {
        "concurrency": {
          "audit": 5,
          "trees": 5,      // NUEVO: pool para fetch de árboles faltantes
          "parents": 5,    // NUEVO: pool para getProcessNodeParents
          "retryDelaysMs": [0, 1000, 2000]
        },
        "duplicates": {    // NUEVO bloque
          "enabled": true,
          "includeSources": ["main","satellite","rt","subprocess","stepshipping"],
          "ignoreNamePatterns": [],
          "ignoreIds": []
        }
      }
    }
  }
}
```

`ignoreNamePatterns` (regex strings) e `ignoreIds` permiten excluir nodos del análisis sin redeploy de scripts. Misma filosofía que `satelliteOverrides`.

**Hashes GraphQL:** sin cambios. `getProcessTree` y `getProcessNodeParents` ya están en config desde v0.7.0.

## 8. Archivos a tocar (deploy `gh-pages`)

| Archivo | Cambio |
|---|---|
| `remote/scripts/process-shared.js` | Agrega `signatureD1/D2/D3`, `groupBySignature`. Bump `__psVersion`. |
| `remote/scripts/process-deep-audit.js` | Agrega `evaluateD`, `pickCanonical`, hojas D1/D2/D3 + Leyenda, título mergeado por hoja, panel con descripciones + sección Duplicados. Bump `VERSION`. |
| `remote/config.json` | Bump version + `lastUpdated` + bloque `duplicates` + concurrency `trees/parents`. |
| `extension/background.js` | Sin cambios. |
| `docs/processes-architecture.md` | Nueva sección 11 ("Detección de duplicados") + entrada en glosario §9. |

Procedimiento de deploy: el documentado en `CLAUDE.md` (bump version → commit en `main` → switch a `gh-pages` + copia manual → commit + push ambas ramas).

## 9. Casos de prueba (validación post-deploy)

| Caso | Esperado |
|---|---|
| `SP Embarque en Almacén` (7 IDs activos conocidos) | D1: 1 grupo, 7 filas. Canónico = id más bajo con más parents. 6 filas `FUSIONAR`/`ARCHIVAR`. |
| Dos PROCESS top-level con mismos hijos directos (IDs idénticos) | D2: 1 grupo, 2 filas. También en D3. `TambienEnD3=true`. |
| Dos PROCESS top-level con mismos nombres pero IDs distintos en hijos | D3: 1 grupo, 2 filas. NO en D2. |
| Satélite huérfano sin parents | D1 + `ReferenciasEntrantes=0` + `AccionSugerida="ARCHIVAR"`. |
| RT con árbol clon de PROCESS principal | D3 cross-source: una fila `source=rt`, otra `source=main`. |
| Cancelación a mitad de fetch de árboles faltantes | D1 completo. D2/D3 con `PARCIAL_POR_CANCELACION` en Resumen. Sin requests colgados. |
| 502 individual en `getProcessNodeParents` | Nodo sin `ReferenciasEntrantes`. `AccionSugerida` vacía. Resto del grupo sigue. |
| `ignoreIds: [109804]` en config | 109804 excluido del análisis. Grupo de SP Embarque queda en 6 filas. |

## 10. Plan de validación en producción

1. Bump `version` a `0.8.0` en `main`. Commit.
2. Switch a `gh-pages`, copiar `remote/scripts/process-shared.js`, `process-deep-audit.js`, `config.json` con su layout aplanado. Commit + push ambas ramas.
3. Esperar 30-60s para refresh de GitHub Pages.
4. Recargar extensión (chrome://extensions → reload) o reiniciar Chrome.
5. Verificar en consola: `[SA] process-deep-audit cargado · v0.8.0` y `[SA] process-shared cargado · v0.8.0`.
6. Correr "Auditoría Profunda" en Steelhead.
7. Verificar panel: sección "Duplicados ★ NUEVO" con D1/D2/D3 y conteos `grupos / miembros`.
8. Descargar XLSX. Confirmar 10 hojas (incluyendo Leyenda).
9. Validar título mergeado fila 1 en cada hoja.
10. Validar grupo "SP Embarque en Almacén" en D1 (≥7 filas).
11. Cancelación: re-correr y detener durante "auditando árboles faltantes · X/55". Confirmar `PARCIAL_POR_CANCELACION` en Resumen.

## 11. Riesgos y mitigaciones

| Riesgo | Mitigación |
|---|---|
| Universo más grande de lo estimado (~530 nodos) → fetch de árboles faltantes tarda más | Pool de 5; logs con avance "X/Y árboles"; usuario puede cancelar. |
| `getProcessNodeParents` se vuelve lento si Steelhead lo deprioriza | Cap en concurrency (5) + retries. Si falla, `AccionSugerida` queda vacía pero el grupo sí se reporta. |
| Falsos positivos en D2 cuando dos procesos legítimamente comparten template | Cross-flag `TambienEnD3` ayuda a diferenciar; operador decide en `AccionSugerida_NUEVO`. |
| Cambio de panel afecta percepción visual para usuarios acostumbrados a v0.7.x | Descripciones son aditivas (siglas se mantienen); cambio incremental. |
| Hash de árbol identico entre PROCESS y SUB_PROCESS marca duplicado real cuando no lo es | Es señal legítima (alguien copió un SUB_PROCESS como PROCESS); operador decide con `Source` y `AccionSugerida_NUEVO`. |

## 12. Métricas de éxito

Al término del primer run en producción:
- ≥1 grupo D1 detectado para `SP Embarque en Almacén` con sus 7 miembros.
- Tiempo total < 7 min (vs ~3-5 min actual).
- Cero requests colgados tras cancelación.
- XLSX abre limpio en Excel y LibreOffice.
- Operador puede llenar `AccionSugerida_NUEVO` en al menos un grupo y ese XLSX queda listo para Fase 2.
