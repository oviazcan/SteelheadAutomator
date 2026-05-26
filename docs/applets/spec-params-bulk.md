# `spec-params-bulk` 0.9.0: MVP de carga masiva de SpecParam (2026-05-18, pushed `de9ce8d`/`9630dab`, validación en prod PENDIENTE)

Applet nuevo con dos actions independientes que comparten el mismo bundle:
- **`download-spec-params`** — panel selector (filtros Tipo Internal/External, "Excluir MP", buscador), pool 5 `GetSpec` + pool 10 `GetSpecFieldParamToEdit` para shape completo, genera XLSX con hoja **Params** (1 fila por SpecParam, columnas `*_NUEVO` editables paralelas) + hoja **Leyenda** con reglas de uso.
- **`upload-spec-params`** — file-picker, re-fetchea shape actual de cada `ParamID` para reconstruir el `paramToInputShape` (no se confía en lo que viene del XLSX salvo el id), emite diff preview con 3 tabs (Cambios / Sin cambio / Omitidas), batches de 50 secuenciales con retry exponencial `[1000, 2000, 4000]ms`, bitácora XLSX descargable al final (hojas Aplicadas / Errores / Omitidas).

**Decisiones de diseño cerradas con el usuario antes de implementar:**
- Campos editables: TODOS (15 columnas `_NUEVO`: name, descriptionMarkdown, min/max/target, sampleCount, samplingIntervalMin, sensorValidDurationMin, sensorWarningThresholdMin, 7 flags inputRequired/inputRequested/mustBePassing/failingRequiresResolution/requestDocument/oneAtATime/drivesCoupons).
- Filtro MP: doble señal — label exacto `"MP"` OR `name` que arranca con `/^IMP/i` (Inspección de Materia Prima).
- Revisión: solo la activa más reciente por spec (no soporta multi-revisión en MVP).
- Filas nuevas en upload: NO se crean params; filas con `ParamID` vacío o inexistente van a Omitidas.
- Layout XLSX: una sola hoja `Params` con título mergeado A1 + headers en row 2 + autofilter + 41 columnas. La hoja `Leyenda` documenta cada columna y la lista de Reglas (NO agregar filas, `_NUEVO` vacío = conservar, booleans TRUE/FALSE).

**Lecciones clave del ciclo (primera ronda, sin rework — la captura previa pagó):**
- **Captura del scan ANTES de adivinar shapes.** El `scan_results_2026-05-18_140842.json` se sacó con el flujo "Edit Times" del UI nativo y traía `AllSpecs`, `GetSpec`, `GetSpecFieldParamToEdit`, `SaveMultipleSpecFieldParams` con hashes 200-OK y `responseSamples` reales. Sin el scan habríamos adivinado: el `GetSpec` del config estaba **desactualizado** (`88dad363…` → ahora `ab70f1e8…`), y `SaveMultipleSpecFieldParams` no estaba registrado. La inspección con `jq '.scanResults.GetSpec.lastHttpStatus'` y comparar contra config confirma rotación silenciosa de hash (mismo síntoma del playbook "rotación vs deprecación").
- **Dos queries por param en download (no una).** `GetSpec` regresa el árbol `specFieldSpecsBySpecId.nodes[].defaultValues.nodes[]` con la mayoría de campos, **PERO NO** trae `failingRequiresResolution`, `isDefault`, `derivedFromId`, ni `specFieldParamDropdownId`. Esos viven solo en `GetSpecFieldParamToEdit(specFieldParamId, specFieldId)`. Decisión: enriquecer con un segundo pool concurrente de 10 por paramId. Costo: ~250 calls para 50 specs con 5 params cada una, ~30-60s — aceptable porque la descarga es operación poco frecuente. Patrón aplicable a otros applets donde una query "lista" trae shape parcial y otra query "edit" trae el shape completo: hacer fase 1 lista + fase 2 enriquecer, no hardcodear la query "edit" como única (mata performance).
- **No confiar en columnas `_NUEVO` para reconstruir el shape de la mutation.** En upload, el path correcto es: leer SOLO `ParamID` y `FieldID` del XLSX (ambos read-only, lookups), llamar `GetSpecFieldParamToEdit` para obtener el shape actual fresh del server, y solo entonces aplicar los `_NUEVO` como overrides. Si el operador editó por accidente `SpecFieldSpecID` o `DerivedFromID`, no rompemos nada. Patrón generalizable: para mutaciones de update sobre rows editados externamente, la fuente de verdad del estado actual es **siempre** el server, no el archivo subido.
- **`extractIdFromNodeId(nodeId)` como fallback robusto.** El `nodeId` de Steelhead es base64 de `["spec_field_specs", 173321]`. Decodificarlo con `atob` + `JSON.parse` y tomar `arr[1]` es más confiable que castear `Number(xlsxRow.SpecFieldSpecID)` (que puede haber sido editado por accidente). Aplicable a cualquier sitio donde Steelhead te dé un `nodeId` y necesites el id numérico — siempre prefiere decodificar el nodeId sobre confiar en otra columna.
- **Cancellation token + pool con semáforo + retry exponencial: mismo patrón de `process-deep-audit`.** `state.runId` monotónico, `isStale(myRunId)` / `bailIfStale(myRunId)`, `runPool(items, worker, concurrency, onProgress, myRunId)` con semáforo manual, `withRetry(fn, label, myRunId)` que respeta cancelación entre intentos. El "Cancelar" del panel hace `nextRunId()` que invalida todos los `myRunId` capturados localmente. Hasta los helpers de retry deben aceptar `myRunId`, o el botón Detener no responde hasta que termine el lote actual.
- **`SpecShared` como módulo compartido desde el primer día.** No esperar hasta que un segundo applet quiera reusar — meter constantes + queries + helpers en `spec-shared.js` desde el principio facilita Fase 2 (write-back desde XLSX editado a mano) o un applet hermano que solo lea. Sigue el patrón de `process-shared.js`.

**Hashes registrados en `remote/config.json` (deploy 0.9.0):**
| Operación | Hash | Tipo |
|---|---|---|
| `AllSpecs` | `0710bf2eb9fa02f1fff3899be3629d1169d0af92564ec9aadb0a25ddd5ab19cb` | query (ya estaba) |
| `GetSpec` | `ab70f1e818961973705ce720e3f22e8eefc7c204e0f14543de8d5825a41155c3` | query (REEMPLAZADO desde `88dad363…`) |
| `GetSpecFieldParamToEdit` | `f4aedfe3fbe7ef82ae55c7bd37b76637d18c9ce6fbfe257ef9618fd8b85aa75b` | query (ya estaba) |
| `SaveMultipleSpecFieldParams` | `bffd36ff1ea5e3e5b7ff91b23ebf33c5c7879ee54c35d86ad90e86eab3214b7b` | mutation (NUEVO) |

**Shape de input de `SaveMultipleSpecFieldParams`** (uno por param dentro del array `input.specFieldParams[]`):
```js
{
  id, isDefault, specFieldSpecId, derivedFromId, descriptionMarkdown,
  inputRequired, inputRequested, mustBePassing, failingRequiresResolution,
  requestDocument, minimumValue, maximumValue, targetValue, samplingRate,
  sampleCount, sampleSetId, samplingIntervalMinutes, specFieldParamDropdownId,
  oneAtATime, name, unitId, sensorValidDurationMinutes,
  sensorWarningThresholdMinutes, processNodes: [], defaults: [], optInOuts: [],
  updateDerivedFroms: true, operation: null, drivesCoupons, classificationIds: []
}
```
Atención: `processNodes`, `defaults`, `optInOuts`, `classificationIds` se mandan SIEMPRE vacíos en MVP (no editables). Si en Fase 2 se quiere editar `processNodeSpecFieldParams` o `optInOuts`, hay que construir el shape correcto desde sub-hojas del XLSX.

**Files tocados (deploy `de9ce8d` main / `9630dab` gh-pages):**
- NUEVO `remote/scripts/spec-shared.js` (~314 LOC) — catálogo lazy + helpers compartidos.
- NUEVO `remote/scripts/spec-params-bulk.js` (~1027 LOC) — applet download/upload.
- MODIFICADO `remote/config.json` — bump 0.8.0 → 0.9.0; `GetSpec` hash; `SaveMultipleSpecFieldParams` mutation; app `spec-params-bulk` con 2 actions; sección `domain.specParamsBulk` (concurrency.fetchDetails=5, concurrency.editShape=10, batchSize=50, retryDelaysMs=[1000,2000,4000], page.first=400, labelMP="MP", impPrefixRegex="^IMP").
- MODIFICADO `extension/background.js` — globals `SpecShared`/`SpecParamsBulk` + cases unificados `download-spec-params`/`upload-spec-params` con XLSX injection.

**Estado de deploy:**
- `main`: `de9ce8d` — **pushed** a remote.
- `gh-pages`: `9630dab` — **pushed** a remote.

**Plan de validación PENDIENTE (a ejecutar tras reload de extensión, ~30-60s después del push):**

*Descarga:*
1. Abrir applet → action **Descargar XLSX**.
2. Filtros `Externas` + `Excluir MP=off` + búsqueda vacía → verificar que el contador del botón ≈ totalCount esperado.
3. Filtros `Internas` + `Excluir MP=✓` → specs con nombre `IMP…` o label `MP` deben desaparecer.
4. Búsqueda `T104` → filtrado client-side correcto.
5. Seleccionar 2-3 specs conocidas + descargar → XLSX abre en Excel, 2 hojas (Params + Leyenda), autofilter en row 2, columnas `_NUEVO` vacías, título mergeado A1.

*Carga (caso del scan):*
6. En el XLSX descargado, ubicar `ParamID = 19938651` ("20 - 62 g/L" del field "T104-TI00-001 Concentración de Alcalinidad", spec T104-LI #341).
7. Llenar `SensorValidDurationMin_NUEVO = 5760` y `SensorWarningThresholdMin_NUEVO = 5700`.
8. Guardar y subir → action **Cargar XLSX editado**.
9. Verificar preview: 1 cambio, 0 sin cambio, 0 omitidas; el diff debe mostrar `sensorValidDurationMinutes: 4320 → 5760` y `sensorWarningThresholdMinutes: 4260 → 5700`.
10. Confirmar → bitácora descargable + cross-check en UI nativo (abrir el param, confirmar valores nuevos).

*Edge cases:*
11. Fila con `ParamID = ""` → Omitidas, motivo `"ParamID vacío"`.
12. Fila con `ParamID = 99999999` (inexistente) → Omitidas, motivo `"paramId desconocido"` (o el error que devuelva el server).
13. Todos los `_NUEVO` vacíos → `sinCambio = N`, `cambios = 0`, botón Confirmar deshabilitado.
14. Cancelar a media descarga (con 30+ specs seleccionadas) → pool aborta sin XLSX descargado, panel cierra.
15. Simular 502 (interrumpir red durante un batch) → retry 1s/2s/4s; tras 3 fallos, batch va a `errors[]` sin abortar la corrida.
16. Cancelar a media carga multi-batch → batches previos quedan aplicados, bitácora marca PARCIAL.

Si la validación revela algún gap (regex mal calibrado, shape distinto en alguna spec con campos opcionales raros, output XLSX mal formado, comportamiento del UI nativo distinto), abrir sesión nueva con el screenshot del panel + el XLSX descargado + (si aplica) un `scan_results_*.json` fresh.

**Pendientes derivados (no bloqueantes para MVP):**
- **Fase 2 — soporte de campos relacionales.** Editar `unitId`, `sampleSetId`, `classificationIds`, `processNodes`, `optInOuts`, `specFieldParamDropdownId`. Requiere hojas extra "Units", "SampleSets", "Classifications", etc. con catálogos auxiliares y validación de FKs en upload. No-bloqueante: MVP edita los 15 campos atómicos que cubren 95% del uso real (vigencia, rangos, flags).
- **Fase 2 — creación de SpecParams nuevos** (no solo edición). Requiere validar `specFieldSpecId`, `derivedFromId`, `isDefault`, y manejo de `updateDerivedFroms: true` cuando se crea un derivado.
- **Multi-revisión.** Descargar todas las revisiones (no solo la activa). El usuario explícitamente eligió MVP solo activa.
- **Refactor de `spec-migrator`** para que use `SpecShared.loadSpecCatalog()` y elimine la lógica duplicada de paginación de `AllSpecs`. Deuda técnica reconocida; el MVP funciona sin esto.
- **Pinear hashes SHA-256** de `spec-shared.js` y `spec-params-bulk.js` en `config.json` (item 1 del audit pre-producción global).

