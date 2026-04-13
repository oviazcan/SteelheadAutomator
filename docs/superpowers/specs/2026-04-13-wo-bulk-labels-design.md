# Gestión Masiva de OT — Etiquetas

## Resumen

Extender el applet "Cambio Masivo de Plazos OT" para también agregar y quitar etiquetas de work orders de forma masiva. La interfaz conserva los mismos filtros; el usuario puede aplicar solo fecha, solo etiquetas, o ambos.

## Cambios de nombre

- Título del modal: `"📅 Cambio Masivo de Plazos OT"` → `"⚙️ Gestión Masiva de OT"`
- `config.json` sublabel: `"Seleccionar OTs y aplicar nueva fecha"` → `"Cambiar plazos y etiquetas masivamente"`
- El `id` del botón (`run-wo-deadline`) y el nombre del script se mantienen para no romper nada.

## Queries y mutations nuevos en config.json

| Operación | Hash | Variables |
|---|---|---|
| `DeleteWorkOrderLabels` | `0bd35abe9ed820c45702d49199b4e799ba6dd3b9484bfeaecba23d3c2962af59` | `{woId}` (id interno, no idInDomain) |
| `CreateWorkOrderLabel` | `e3d57bbe80a5cedd12c29766ae1f7546cd7a2b69a16aaf09af1ba2f1eaa13f60` | `{workOrderId, labelId}` |

`AllLabels` ya existe en config. Se usa con `{condition: {forWorkOrder: true}}`.

## UI

### Sección de etiquetas

Se agrega entre la fila "seleccionar todo / nueva fecha" y el grid de cards. Dos filas:

1. **"Agregar:"** — chips de todas las etiquetas con `forWorkOrder: true`, con su color real. Click para toggle (borde highlight cuando seleccionada).
2. **"Quitar:"** — solo chips de etiquetas presentes en al menos una OT del set filtrado actual. Click para toggle.

Los chips muestran el nombre de la etiqueta con fondo del color real y texto claro/oscuro según luminosidad (función `labelTextColor` existente).

### Cards de OT

Agregar una fila debajo de la fecha mostrando las etiquetas propias de la OT (badges con color), similar a como se muestran las etiquetas de PN.

### Botón dinámico

| Estado | Texto |
|---|---|
| Solo fecha seleccionada | `APLICAR FECHA (N)` |
| Solo etiquetas seleccionadas | `APLICAR ETIQUETAS (N)` |
| Fecha + etiquetas | `APLICAR CAMBIOS (N)` |
| Nada | Disabled |

## Datos de etiquetas por OT

`AllWorkOrders` retorna `workOrderLabelsByWorkOrderId.nodes[]`. La estructura esperada de cada nodo es `{labelByLabelId: {id, name, color}}` — misma convención que `partNumberLabelsByPartNumberId` en PN. Si los nodos vienen sin sub-relación (solo `labelId`), se hará lookup contra el catálogo de AllLabels.

## Lógica de ejecución

Para cada OT seleccionada:

### Solo agregar (sin quitar)
- `CreateWorkOrderLabel({workOrderId, labelId})` por cada etiqueta a agregar que la OT no tenga ya.

### Con quitar (con o sin agregar)
1. `DeleteWorkOrderLabels({woId})` — borra todas las etiquetas de la OT.
2. `CreateWorkOrderLabel({workOrderId, labelId})` por cada etiqueta que:
   - La OT ya tenía Y no está marcada para quitar, O
   - Está marcada para agregar.

### Solo fecha
- `CreateUpdateWorkOrdersChecked({input: [{id, deadline}]})` — sin cambios al flujo actual.

### Combinación fecha + etiquetas
- Se aplican en secuencia: primero etiquetas, luego fecha (o en paralelo si no hay dependencia).

### Batching
- Etiquetas: procesar OTs en batches de 10 (cada OT puede requerir delete + N creates).
- Fecha: batches de 50 (igual que hoy).

## Resumen final (summary dialog)

El diálogo de resumen muestra:
- OTs con fecha actualizada (si aplica)
- Etiquetas agregadas (count)
- Etiquetas quitadas (count)
- Errores

## Archivos a modificar

1. `remote/config.json` — nuevos hashes + sublabel actualizado
2. `remote/scripts/wo-deadline-changer.js` — toda la lógica nueva
