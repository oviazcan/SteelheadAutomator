# `spec-migrator` (bundle "Ajuste Masivo de Specs")

Bundle del menú **Ajuste Masivo de Specs** (icono 🔀, categoría "Números de Parte"). Concentra acciones que **ajustan o validan** specs ya aplicadas a PNs — distinto del bundle `spec-params-bulk` (Calidad), que **edita parámetros** vía XLSX.

Scripts: `steelhead-api.js` + `spec-migrator.js`. Sin VERSION constant exportado; las versiones se trackean por acción en este doc.

## Acciones

| Acción | Función | Origen |
|---|---|---|
| `run-spec-migrator` (Migrar Specs) | `SpecMigrator.run` | original 2024 |
| `assign-pending-params` (Asignar Params Pendientes) | `SpecMigrator.assignPendingParams` | original 2024 |
| `resolve-conflicts` (Resolver Conflictos) | `SpecMigrator.resolveConflicts` | original 2024 |
| `validate-duplicate-params` (Validar params duplicados) | `SpecMigrator.runDuplicateParamsValidator` | **0.4.3 — 2026-05-25, bump config 1.4.38** |

---

# `validate-duplicate-params` 0.4.3 (2026-05-25, bump config 1.4.38) — regla null-only por SpecField (alineación con bulk-upload 1.4.38)

## Síntoma / petición
Tras 0.4.2, el usuario probó el validator sobre PN 3027939 y observó que el toggle global "Archivar params con processNodeId = NULL" estaba al revés de la regla buena: bulk-upload 1.4.38 ahora exige que el row vivo de cada `SpecField` tenga `processNodeId=null`. El toggle hacía justo lo contrario.

Adicionalmente, el usuario clarificó el modelo:
> "debes pensar que los specfields 'agrupan' los parámetros… SOLO un parámetro por specfield, nunca más de uno"

Y la regla para grupos con sfpIds distintos pero **mismo nombre**:
> "si los dos parámetros se llaman igual, dejamos el que está null… para el manual, sí deben aparecer radios pues hay dos opciones DIFERENTES… el radio seleccionado default debe ser el que trae proceso (no para dejarle el proceso, sino porque es el que insertó bulk upload que está validado)"

## Regla nueva (absoluta — sin toggle)
Por cada grupo de duplicados bajo un `specFieldSpecId` único:

| Caso | Clasificación | Acción |
|---|---|---|
| 1 sfpId, ≥1 NULL | `autoDecidable=true` | Conservar NULL más reciente; archivar el resto (otros NULLs + todos los con processNode). |
| 2+ sfpIds con MISMO `paramName` | `autoDecidable=true` | Igual al caso 1 — el nombre repetido confirma duplicación pura. |
| 2+ sfpIds con `paramName` DISTINTO | `autoDecidable=false` (manual) | Radios para elegir; **default = sfpId con processNode** (es el que bulk-upload acaba de validar contra el catálogo). El validator igualmente insertará el winner como NULL y archivará los rows con processNode. |
| 1 sfpId, sin NULL | `autoDecidable=false` (manual) | El validator sólo archiva — no inserta. Bulk-upload re-pasará y dejará el NULL. |

## Cambios de código
- `spec-migrator.js:2114-2150` — header del bloque reescrito con casos arriba.
- `spec-migrator.js:2469-2515` — `dupRunScan` calcula `sameName` (`mappedParams.every(p => p.sfpName === firstName)`) y `autoDecidable = (sameSfp || sameName) && hasNull`.
- `spec-migrator.js:2558` — banner púrpura del toggle eliminado; reemplazado por nota informativa "Regla absoluta: 1 row vivo por SpecField con `processNodeId=null`. Sin toggle."
- `spec-migrator.js:2725-2745` — `dupComputeAutoWinner(g)` simplificado:
  ```js
  function dupComputeAutoWinner(g) {
    if (!g.autoDecidable) return g.params[0].rowId;
    const nulls = g.params.filter(p => !p.processNodeId);
    return (nulls.length ? nulls[0] : g.params[0]).rowId;
  }
  ```
- `spec-migrator.js:2743-2755` — nuevo helper `dupManualDefaultWinner(g)`: default radio = primer param con `processNodeId !== null` (es el row "validado" por bulk-upload).
- `dupState.archiveNullProcessNode` eliminado (default ON o OFF dejaron de tener sentido).

## Bug encontrado durante validación con DevTools (tools/test-null-param-fix.js)
El primer apply sobre PN 3027939 archivó correctamente pero el insert posterior falló:
`Variable "$input" got invalid value "25611423" at "input.paramsToApply[0].specFieldParamId"; Int cannot represent non-integer value`

Causa: al normalizar `sfpId` a String para matching de radio buttons, el insert payload mandaba String donde el schema exige `Int`. Fix en el script DevTools **y en el validator**: `Number(ins.specFieldId)` / `Number(ins.specFieldParamId)` antes de armar `paramsToApply`. (Recuperación del PN 3027939: el usuario lo arregló a mano en la UI de Steelhead.)

## Lección
- **SpecField es el contenedor**. Cualquier validador / dedup / cleanup que agrupe por `sfpId` está roto por construcción — agrupar siempre por `specFieldSpecBySpecFieldSpecId.specFieldBySpecFieldId.id`.
- **`sameName` vs `sameSfp`** son dos formas de la misma duplicación: una es el mismo SpecFieldParam reinsertado, la otra es el catálogo redefinido con sfpId nuevo pero nombre idéntico. Ambas se resuelven igual.
- **El radio default importa**. El usuario eligió "el que trae proceso" no porque quiera conservar el proceso, sino porque ese row es el que bulk-upload acaba de validar contra el CSV — es la fuente de verdad para sfpId.
- **Coerce a Int en boundary del schema**. Si el código interno normaliza IDs a String para keys de Map o matching de UI, el insert payload debe `Number(...)` antes de mandar.

## Pendiente
- [ ] Feature CSV-mode (#110): permitir cargar el CSV de bulk-upload en el validator para que use `wantedSelections` del CSV en vez de "el más reciente" — así el validator puede corregir PNs cargados con bulk-upload viejo sin re-correr toda la carga.
- [ ] audit-incomplete-pns (#111): añadir criterio `duplicate-params per SpecField` al reporte de PNs incompletos.

---

# `validate-duplicate-params` 0.4.2 (2026-05-26, bump config 1.4.37) — UX auto-decision toggle

## Síntoma / petición
Después del fix 0.4.1, el usuario vio la tabla de PN 3027938 (10 params activos → 5 grupos duplicados). Observación: 4 de los 5 grupos eran **el MISMO `SpecFieldParam`** repetido (mismo `sfpId`, mismo nombre "Sí o No" / "Elección") y sólo diferían por `processNodeId` (uno `null`, otro `223469`). Sólo 1 grupo (Espesor) tenía sfpIds distintos ("5.8 - 8.89 µm" vs "7.62 - 15.24 µm").

Cita del usuario:
> "cuando el parámetro es igual, no me pregunte cuál quiero dejar uno a uno, si son iguales, pues que ni me pregunte, si uno tiene processNodeId y otro no, que sea un toggle global: Archivar el processIDNull o algo así si no se marca se archiva el otro. Obvio para los que los parámetros son diferentes como en este caso el espesor, SÍ debo de seleccionar yo cuál dejar."

## Clasificación de grupos (nueva)
Cada grupo ahora incluye 2 flags computados en `dupRunScan`:

- `sameSfp` — todos los params del bucket comparten `sfpId` (caso "copia accidental con/sin proceso").
- `autoDecidable` — `sameSfp === true` AND existe ≥1 param con `processNodeId` AND ≥1 sin (`null`). Sólo en este caso el toggle global decide; si todos son null o todos tienen processNode (raro), cae a "manual" para evitar ambigüedad.

## UI
- **Stats bar**: agrega `Auto-decidibles` y `Manuales`.
- **Toggle global** (sólo si hay auto-decidibles): banner púrpura con checkbox `Archivar params con processNodeId = NULL en los N grupos auto-decidibles…`. Default **ON**. Al togglear, recomputa el `winnerRowId` de todos los autoDecidable y re-renderiza la tabla.
- **Pill por grupo autoDecidable**: reemplaza los radios con un panel `⚙ AUTO (mismo param, N filas)` y filas `✓ CONSERVA` / `✗ ARCHIVA` con `row#` + `pn#` (o `· NULL`). El usuario no escoge nada manualmente — la decisión sigue al toggle.
- **Radios manuales**: persisten sin cambios para grupos con `autoDecidable === false` (caso Espesor).
- **Ignorar**: se mantiene en autoDecidable también (el usuario puede excluir un grupo auto del fix si lo ve raro).

## Wiring
- `remote/scripts/spec-migrator.js:2228` — agrega `dupState.archiveNullProcessNode: true`.
- `spec-migrator.js:2438-2484` — clasificación `sameSfp` / `autoDecidable` + winner inicial.
- `spec-migrator.js:2659-2675` — nuevo helper `dupComputeAutoWinner(g)` (regla: si toggle=true, pool=params con processNodeId; el más reciente gana).
- `spec-migrator.js:2503-2545` — banner toggle global + handler que recomputa winners y re-renderiza.
- `spec-migrator.js:2581-2614` — branch `if (g.autoDecidable)` que pinta pill en vez de radios.
- `spec-migrator.js:2776` — XLSX agrega columna `Modo` (AUTO/MANUAL) en la hoja Detectados.

## Por qué `autoDecidable` y no sólo `sameSfp`
Si los dos params son del mismo sfp PERO los dos tienen processNodeId distinto (o ambos null), el toggle no puede decidir qué archivar sin pedirle al usuario. Mejor caer a radios manuales que tomar una decisión silenciosa basada en `max(rowId)` que el usuario no vio venir.

## Pendiente derivado (importante, ya en backlog #105)
**RCA de cómo aparecen estos duplicados**: el usuario apunta a bulk-upload. La hipótesis es que al recargar un PN, el flujo no archiva los params previos antes de crear los nuevos. Ver `docs/applets/bulk-upload.md` cuando se aborde — si se confirma, fix en el script de origen evita seguir generando basura mientras este validator la limpia.

## Plan de validación 0.4.2
- [ ] Correr scan en PN 3027938: 5 grupos, banner muestra "Auto-decidibles: 4 · Manuales: 1".
- [ ] Default ON: pills muestran CONSERVA = `pn#223469`, ARCHIVA = `NULL` en los 4 auto.
- [ ] Desmarcar toggle: pills invierten (CONSERVA = NULL, ARCHIVA = `pn#223469`). Re-marcar revierte.
- [ ] Grupo Espesor sigue mostrando radios manuales — confirmar selección persiste al togglear el banner.
- [ ] Aplicar fix con toggle ON → 4 NULLs archivados + 1 manual aplicado.
- [ ] XLSX bitácora "Detectados" tiene columna `Modo` con `AUTO`/`MANUAL` correctas.

---

# `validate-duplicate-params` 0.4.1 (2026-05-25, bump config 1.4.36) — Fix shape de agrupación

## Síntoma
El usuario corrió 0.4.0 contra todo el dominio: ~1 hora de scan, reportó **0 duplicados**. Pero tenía PNs reales con 2+ params en el mismo SpecField/Spec (verificado manualmente en UI: PN 3027938 / 3027939 FEDERAL-MOGUL con spec "1.28.032 (Níquel)" mostraba duplicados en "Aspecto Visual", "Espesor" y otro).

## Diagnóstico
El response de `GetPartNumber` en `partNumberSpecFieldParamsByPartNumberId.nodes[]` NO expone `partNumberSpecId`. El shape real (confirmado con scan_results_2026-05-25_201858.json, `GetPartNumber` count=2306 errCount=0):

```
{
  id, archivedAt, specFieldId, processNodeId, processNodeOccurrence,
  locationId, geometryTypeSpecFieldId,
  specFieldParamBySpecFieldParamId: {
    id, name, specFieldSpecId,
    specFieldSpecBySpecFieldSpecId: {
      id (= specFieldSpecId), specId,
      specBySpecId: { id, idInDomain, name, ... },
      specFieldBySpecFieldId: { id, name, ... }
    }
  }
}
```

`p.partNumberSpecId` → `undefined`. El código 0.4.0 hacía:
```js
const psId = p.partNumberSpecId;
if (!psId || !sfId) continue;   // ← descartaba TODOS los params
```

Resultado: `buckets` siempre vacío, 0 grupos. Silencioso porque el log solo decía "0 grupos duplicados" sin advertir que `psId` venía undefined.

Comprobado contra el sample del scan (PN 3027939, 12 params activos): la key `specFieldId` da 3 grupos duplicados; `specFieldSpecId` da los mismos 3; la key (sfs.id, processNodeId, locationId) da 0 (porque uno tiene processNodeId null y otro no — pero el usuario quiere flag-earlos como duplicados igual: la regla operacional es "uno y sólo uno por SpecField de Spec").

## Fix
- `remote/scripts/spec-migrator.js:2387` — quitado `usagesLimit/usagesOffset` de `GetPartNumber({ partNumberId: pn.id })` (el UI nativo usa `usagesLimit:10`; pasar 0 era sospechoso y el shape full ya trae todo lo necesario).
- `remote/scripts/spec-migrator.js:2397-2456` — reescritura de la agrupación:
  - Key: `specFieldParamBySpecFieldParamId.specFieldSpecBySpecFieldSpecId.id` (= `specFieldSpecId`).
  - Eliminado `psMap` (innecesario — el specName/fieldName vienen anidados en el shape del param).
  - Filtro de spec se aplica per-param antes de bucketizar.
  - Expone `processNodeOccurrence` y `locationId` en `params[]` para diagnóstico futuro.

## Hallazgo bonus
La función `getPNDetail(partNumberId)` original (`spec-migrator.js:74-79`) también usa `usagesLimit: 0, usagesOffset: 0`. NO se tocó porque las 3 acciones originales (Migrar Specs / Asignar Pendientes / Resolver Conflictos) llevan meses operando con eso. Si en algún momento se sospecha de comportamiento raro en esas acciones, ahí hay un candidato (el UI nativo usa `usagesLimit:10`; bulk-upload usa `1`; "0" es valor no-natural).

## Lecciones
- **Asumir un campo existe sin verificarlo en el response real es la regla #1 de bugs silenciosos.** Mi mental model decía "partNumberSpecId es la FK natural" (vista en mutations), pero el query no la expone en ese node. El scan tenía el responseSchema completo desde el día 1 — un grep antes de codificar habría evitado el bug entero.
- **Logging defensivo cuando hipotetizas el shape**: si `psId = undefined` causaba descartar TODOS los params, el log debió haber tenido un counter `paramsRejectedNoPsId` que disparara una warning cuando >50% de los params se descartaban.
- **Probar contra un PN conocido-con-duplicados antes del scan completo**: 1 hora perdidos pudieron ser 30 segundos con un solo `GetPartNumber({partNumberId: 3027938})` en DevTools.

## Plan de validación (vigente)
- [ ] Correr scan con filtro `cliente=FEDERAL-MOGUL` y verificar que aparece el grupo de PN 3027938/3027939 (espesor, aspecto visual y otro).
- [ ] Aplicar fix sobre un grupo controlado, confirmar archivo en UI.
- [ ] Re-correr scan y confirmar 0 dups en ese PN.
- [ ] Revertir manualmente con `UpdatePartNumberSpecParam{id, archivedAt:null}` para confirmar reversibilidad.

---

# `validate-duplicate-params` 0.4.0 (2026-05-25, bump config 1.4.35) — INICIAL, bug de shape

Detecta y limpia PNs con >1 param activo para el mismo `(partNumberSpecId, specFieldId)` — el caso "espesor con 3 parámetros, uno con processNode default y dos sin" que aparece después de cargas masivas mal dedupeadas.

**Ubicación correcta** (corrección del usuario): vive en el bundle `spec-migrator` (Ajuste Masivo de Specs), NO en `spec-params-bulk` (Carga masiva Spec Params). La regla: ajuste + validación van en spec-migrator; edición de parámetros en spec-params-bulk.

**Flujo:**
1. **Filtros opcionales** — `cliente` (substring uppercase, contra `customerByCustomerId.name`) y/o `spec` (substring lowercase, contra `specBySpecId.name`). Vacío = todos los PNs activos.
2. **Fase 1: `AllPartNumbers` paginado** (`first:500`, `NAME_ASC`) con `dupWithRetry`. Filtra archivedAt y aplica filtro cliente al vuelo.
3. **Fase 2: `dupRunPool(allPNs, GetPartNumber, 6)`** con `usagesLimit:0`. Por cada PN:
   - Construye `psMap: partNumberSpecId → {specId, specName, specIdInDomain}` solo con specs activas.
   - Si hay `specFilter` y ninguna spec activa matchea, descarta el PN.
   - Agrupa `partNumberSpecFieldParamsByPartNumberId.nodes` activos por `(partNumberSpecId, specFieldId)`.
   - Flagea grupos con `length >= 2`. Resuelve `fieldName` cruzando `pnSpecs[].specBySpecId.specFieldSpecsBySpecId.nodes`.
   - Default winner = mayor `id` (más reciente). Persiste en `dupState.decisions` como `Map<groupKey, {winnerRowId, ignored}>`.
4. **Tabla interactiva** (DOM API + `textContent`, cero `innerHTML` para datos) con stats bar: PNs revisados, PNs con duplicados, grupos, params a archivar.
   - Por grupo: PN | Cliente | Spec | SpecField | Radios (1 por param, preselecciona winner, muestra `row#…·sfp#…·pn#…·más reciente`) | Checkbox **Ignorar**.
   - Cambiar radio re-pinta loser/winner colors; toggle ignorar grisea fila y la excluye del contador del footer.
5. **Aplicar fix** — `confirm()` defensivo, luego `dupRunPool(tasks, UpdatePartNumberSpecParam{archivedAt:nowISO}, 3)` con `dupWithRetry`. Bitácora XLSX descargable (hojas **Detectados** con decisión por fila, **Aplicadas**, **Errores**). También se puede descargar el snapshot pre-aplicación desde la tabla.

**Decisiones del usuario (cerradas antes de implementar):**
- Universo de escaneo: todos los PN activos + filtro cliente + filtro spec, ambos opcionales y combinables.
- Default winner: mayor `id` (más reciente).
- Modo fix: archivar (reversible) vía `UpdatePartNumberSpecParam{id, archivedAt: ISO}` — el mismo mecanismo que `archiveParam(paramId)` en `spec-migrator.js:130`, reversible con `archivedAt: null`.

**Wiring:**
- `remote/scripts/spec-migrator.js` — bloque al final del IIFE (helpers `dup*` con CSS namespace `sa-specm-dup-*`, tema púrpura `#8b5cf6`). Helpers renombrados con prefijo `dup` para no colisionar con identificadores existentes del módulo.
- `remote/config.json` (línea ~495) — 4ª acción del bundle con label "🧹 Validar params duplicados".
- `extension/background.js` — case dedicado `validate-duplicate-params` que inyecta XLSX library + bundle de spec-migrator y llama `SpecMigrator.runDuplicateParamsValidator()`.

**Cancelación:**
- Estado local `dupState.runId` (no usa la infraestructura `bailIfStale` del bulk-upload — spec-migrator no la tiene). Cada función async guarda `myRunId = dupState.runId` al entrar; vuelve a comparar antes de re-pintar UI o aplicar mutaciones. Cerrar el panel hace `dupState.runId++` y aborta in-flight.

**Lecciones:**
- **No reusar el dedup del propio migrator** — `spec-migrator.js` (la sección original de conflicts) colapsa con `new Set(activeParams.map(p => p.specFieldParamBySpecFieldParamId.id))`, lo que silenciosamente esconde duplicados que difieren por `processNodeId`. Este validador usa el shape correcto: `(partNumberSpecId, specFieldId)` como key, sin colapsar por sfpId — así un grupo de 3 espesores con processNode null/default/A se ve como 3 rows, no 1.
- **`UpdatePartNumberSpecParam` es la mutation más simple para archivar un row individual** — el migrator ya usa este patrón en `archiveParam(paramId)`. Confirma que `archivedAt: ISOString` archiva, `archivedAt: null` revierte. Reversible operativamente.
- **DOM API en lugar de `innerHTML` para tabla con datos del usuario.** Los nombres de PN/cliente/spec pueden venir con caracteres especiales. La tabla se arma con `createElement` + `textContent`. Coherente con el pendiente XSS del audit (#2 medio): esta action lo hace bien desde el inicio.
- **XLSX library debe inyectarse explícitamente** — el bundle de spec-migrator no la cargaba (las 3 acciones originales no la necesitan). El case nuevo de background.js la inyecta antes del bundle para tener `window.XLSX` disponible al descargar la bitácora.

**Plan de validación pendiente:**
- [ ] Correr scan con filtro `cliente=BRP` y verificar que aparecen los grupos conocidos (espesor x3).
- [ ] Aplicar fix sobre un grupo controlado (PN de prueba), confirmar que el row queda archivado en Steelhead UI.
- [ ] Re-correr scan y confirmar que el grupo ya no aparece.
- [ ] Revertir manualmente con `UpdatePartNumberSpecParam{id, archivedAt:null}` para confirmar reversibilidad.
