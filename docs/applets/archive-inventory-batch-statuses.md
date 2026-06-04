# `archive-inventory-batch-statuses` — bitácora

Tool standalone (`tools/archive-inventory-batch-statuses.js`) que se pega en la
consola de DevTools sobre `app.gosteelhead.com` e **inyecta un panel flotante**
para archivar registros del catálogo **`InventoryBatchStatus`** (los "estatus de
lotes de inventario") cuando la UI nativa falla. NO es parte de la extensión;
corre ad-hoc en la sesión del navegador (cookies same-origin).

## Qué resuelve

La UI de Steelhead para configurar estatus de lotes **falla al archivar** con
`"An unexpected error occurred."`. El tool lista todos los estatus de un
inventory type (con su **color** e **id**), deja seleccionar cuáles archivar con
checkboxes, y trae un **detector de lotes en uso** que dice de antemano cuáles se
pueden archivar y cuáles no.

## Root cause (CONFIRMADO 2026-06-03)

`ArchiveInventoryBatchStatus` **truena solo cuando el estatus tiene lotes activos
en ese estado** — casi seguro una violación de FK / validación faltante en el
backend (PostGraphile) que deja burbujear la excepción como
`"An unexpected error occurred."` en lugar de un error de negocio claro. **Si el
estatus está vacío, archiva sin problema.** Workaround: vaciar/migrar los lotes
de ese estado a otro estatus, luego archivar.

### Distinción éxito vs fallo (gotcha clave)

`ArchiveInventoryBatchStatus` devuelve `data.archiveInventoryBatchStatus = null`
**en ambos casos**. La diferencia es la presencia de `errors`:

| Caso | `errors` | `data.archiveInventoryBatchStatus` | Realidad |
|---|---|---|---|
| Estatus **vacío** | ausente | `null` | ✅ se archivó |
| Estatus **en uso** | presente (`"An unexpected error occurred."`, `path:["archiveInventoryBatchStatus"]`) | `null` | ❌ falla (lotes en uso) |

⇒ El éxito se mide por **`!response.errors`**, NUNCA por el valor del campo (que
es `null` siempre). La v1.0.0 inicial tenía el bug de exigir `field != null` y
daba **falsos negativos** (el `#322 "NP desconocido"` se archivó de verdad pero
el panel dijo `error_in_use`). La verificación por re-consulta lo destapó.

## Callejones sin salida (descartados con evidencia)

1. **`archivedAt: "NOW"`** — la UI manda ese literal; se pensó que el resolver
   truena al parsearlo. **Refutado:** falla idéntico con ISO completo, ISO sin
   ms, `YYYY-MM-DD` y `NOW`. El valor de `archivedAt` es **irrelevante**.
2. **`UpdateInventoryBatchStatus` para setear `archivedAt`** (esquivar el resolver
   roto). **Refutado:** su documento persisted solo expone `name`/`color`/
   `nextStatusId`; la variable `archivedAt` extra se **ignora en silencio**
   (responde `updateInventoryBatchStatusById` OK pero `archivedAt` sigue `null`).
   Como es persisted query, el documento está congelado y no se puede inyectar.
3. **El verdadero:** lotes en uso (ver root cause). Confirmado por el operador:
   al vaciar "Needs Inspection", se archivó.

## Coordenadas (hashes)

Hardcodeados en el tool (es standalone; **no** viven en `config.json` para no
disparar deploy/version bump de la extensión).

| Operación | Hash | Uso |
|---|---|---|
| `ConfigureInventoryBatchStatusesQuery` | `e6bd0b40f5adbad5df1b86ff135c5a7a7a3d0203989f7c9c3925a20a6313aa73` | Lista estatus de un type (id, name, **color**, archivedAt, cadena next/incoming) + todos los types (con `defaultBatchStatusId`). Var: `{typeId}` |
| `ArchiveInventoryBatchStatus` | `10865607bb10ff407dc2324eb005e9cf6d8ee2c8cef1507b3fbe0d3e62e0baed` | Mutación de archivado. Var: `{input:{id, archivedAt}}`. Truena si hay lotes |
| `InventoryBatchViewQuery` | `e4fc4cdf098f41e10881a512e63ce6fb068bcd8d5bd57b8627c86e5fda025d44` | **Detector:** filtra lotes por `inventoryBatchStatusIdFilter:[id]`, devuelve `pagedData.totalCount`. Var detector: `{includeArchived:'NO', orderBy:['CREATED_AT_DESC'], offset:0, first:1, inventoryBatchStatusIdFilter:[id], searchQuery:''}` |
| `UpdateInventoryBatchStatus` (NO usado) | `8cf2ca922e714bfe3f80ab49b3d30cd8ffedd03a76490181196617536724d5d4` | Edita name/color/nextStatusId. **No** expone `archivedAt` (ver callejón #2) |
| `AllInventoryBatchStatuses` (en config.json, lo usa `inventory-reset`) | `37ef2266975d34d4318858553f68e56638c25ebff9bb4f16d080589c213cef09` | Variante más simple de listado por `{typeId}` |

Descubiertos del scan `~/Downloads/scan_results_2026-06-03_182307.json`. Default
type: **2191 "Números de Parte"** (`defaultBatchStatusId: 319 "Por validar"`).

## Mecanismo

1. **Cargar type** con `ConfigureInventoryBatchStatusesQuery` → estatus ordenados
   por id + lista de types para el dropdown.
2. **Render** con checkbox · swatch de color (validado hex) · `#id` · nombre ·
   pills de contexto: `→ next`, `←N` (transiciones entrantes), `default`,
   `archivado`, y (tras correr el detector) `✓ 0 lotes` / `🔴 N lotes`.
3. **Detector** (botón "🔍 Contar lotes en uso"): por cada estatus no archivado,
   `InventoryBatchViewQuery` con `first:1` → lee `pagedData.totalCount`
   (concurrencia 3). Los `🔴 >0` no se podrán archivar.
4. **Archivar** seleccionados: `ArchiveInventoryBatchStatus` por id. El `confirm`
   avisa de default, transiciones entrantes y (si se corrió el detector) los que
   tienen lotes. Éxito = `!errors`. Re-consulta para **verificar** (fuente de
   verdad final) y descarga `archive-batch-status_EXEC.json`.

## 1.0.0 — 2026-06-03 — Implementación inicial (panel UI + detector)

### Decisiones de diseño

- **Anti-XSS.** Panel construido con `createElement` + `textContent` para todo
  dato dinámico; colores validados con `^#[0-9a-fA-F]{3,8}$` antes de aplicarse a
  `style` (sigue el pendiente MEDIO del audit, `CLAUDE.md` → Seguridad).
- **No bloquea, avisa.** Un estatus en uso (o default, o con incoming) se puede
  seleccionar igual; el panel solo avisa. La verificación final reconcilia el
  estado real.
- **Detector cuenta solo lotes ACTIVOS** (`includeArchived:'NO'`), que es lo que
  confirmamos que bloquea el archivado. ⚠ Si algún estatus marca `✓ 0 lotes`
  pero igual truena, revisar si también cuentan completados/archivados y ampliar
  el filtro.
- **Idempotente.** Los ya archivados salen deshabilitados.

### Fetch

`POST /graphql`, `credentials:'include'`, `content-type:application/json`,
extensions con `clientLibrary {@apollo/client, 4.0.8}` + `persistedQuery
{version:1, sha256Hash}`. Cookie de sesión same-origin (sin JWT).

### Validación / uso real

- Sintaxis validada con `node --check`.
- **Run real 2026-06-03:** `#322 "NP desconocido"` archivado OK (estaba vacío) —
  destapó y motivó el fix del falso negativo (`!errors` vs `field != null`).
- El operador archivó "Needs Inspection" tras vaciar sus lotes manualmente
  (confirmó el root cause).

### Pendientes derivados

- [ ] **Migración de lotes** (opción C que el operador no pidió): mover lotes de
  un estatus a otro antes de archivar, de corrido. Requiere capturar la mutación
  que cambia `statusId` de un lote (no catalogada aún). Candidata a revisar:
  ¿`UpdateInventoryBatchesChecked` la soporta, o hay un `MoveInventoryBatch...`?
- [ ] Validar la hipótesis del detector vs lotes completados/archivados (ver
  decisiones). Si un `✓ 0 lotes` truena, ampliar el conteo.
- [ ] **Bug de Steelhead a reportar:** `ArchiveInventoryBatchStatus` debería
  devolver un error de negocio claro ("estatus en uso") en vez de
  `"An unexpected error occurred."`.
- [ ] Si Steelhead rota los hashes, actualizarlos en el tool (no vive en
  `config.json`). Cruzar con el validador diario de hashes.
