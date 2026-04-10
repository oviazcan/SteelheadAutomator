# Resolver de Conflictos de Specs

**Fecha:** 2026-04-10  
**Contexto:** La app de Asignar Params Pendientes no puede asignar params a PNs que tienen 2+ specs con spec fields compartidos. Steelhead bloquea con "conflicting params". Estos PNs se quedan en loop infinito apareciendo como pendientes en cada corrida.

## Problema

Cuando un PN tiene asignadas 2+ specs que comparten el mismo spec field (ej. RC Ni y RC Sn ambas tienen "Espesor", "Adherencia", etc.), Steelhead impide agregar params a cualquiera de esos fields. La solución es archivar las specs redundantes, dejando solo una por spec field.

## Solución

App independiente accesible desde el menú de specs de la extensión. Escanea todas las specs externas, detecta PNs con conflictos de spec fields compartidos, y presenta una UI para que el usuario elija cuál spec conservar por PN. Las specs no seleccionadas se archivan.

## Arquitectura

Todo vive dentro de `spec-migrator.js` como una nueva función exportada `resolveConflicts()`, siguiendo el patrón de `assignPendingParams()`.

### Fase 1: Escaneo

1. Llamar `fetchAllExternalSpecs()` para obtener las ~71 specs externas.
2. Para cada spec, obtener sus PNs asignados activos via `GetSpec` (campo `specPartNumberRelationsBySpecId.nodes`). Filtrar solo PNs activos (`isActive`) y no archivados (`archivedAt === null` en la relación).
3. De-duplicar PNs (un PN puede aparecer en múltiples specs).
4. Para cada PN único, obtener su detalle via `GetPartNumber` → `partNumberSpecsByPartNumberId.nodes` (sus specs asignadas, filtrar archivadas).
5. Para cada spec activa del PN, obtener sus spec fields via `SpecFieldsAndOptions` → `specFieldSpecsBySpecId.nodes`.
6. Construir mapa `specFieldId → [specs que lo usan]`. Si algún field tiene 2+ specs → PN tiene conflicto.

**Batching:** Specs en batches de 20 (`Promise.all`), PNs detalle en batches de 10 (`Promise.all`). Cache de `SpecFieldsAndOptions` por specId para no repetir queries.

**Progreso:** Barra de progreso durante escaneo con fases: "Cargando specs...", "Revisando PNs...", "Detectando conflictos...".

### Fase 2: Presentación

Modal con la lista de PNs con conflicto. Cada entrada muestra:

```
┌─────────────────────────────────────────────────────────────┐
│ 10-4305002-001                                    🔗 Ignorar│
│ Fields compartidos: Espesor, Adherencia, Aspecto Visual,   │
│                     Primeras Piezas, Instrumento de Medición│
│                                                             │
│  ○ RC Ni (Níquel)     ← radio button                       │
│  ● RC Sn (Estaño)     ← radio button (seleccionado)        │
│                                                             │
│ Se archivará: RC Ni (Níquel)                                │
└─────────────────────────────────────────────────────────────┘
```

**Elementos:**
- **Nombre del PN** como encabezado de la tarjeta.
- **Link 🔗** abre `https://app.gosteelhead.com/part-number/{pnId}/specs` en nueva pestaña.
- **Checkbox "Ignorar"** deshabilita los radio buttons y excluye el PN de la ejecución.
- **Lista de fields compartidos** para contexto.
- **Radio buttons** por cada spec involucrada en el conflicto. Ninguno pre-seleccionado (obligar al usuario a elegir).
- **Texto dinámico** "Se archivará: X, Y" mostrando las specs que se van a archivar (las no seleccionadas).

**Controles globales:**
- Contador: "X de Y PNs configurados" (que tienen radio seleccionado y no están ignorados).
- Botón **"EJECUTAR"** habilitado solo cuando todos los PNs no-ignorados tienen una spec seleccionada.
- Botón **"CANCELAR"**.

**Scroll:** El contenido de PNs es scrollable (max-height ~60vh). Si hay muchos PNs, mostrar campo de búsqueda para filtrar por nombre.

### Fase 3: Ejecución

Para cada PN no ignorado:
1. Obtener las specs a archivar (las no seleccionadas por el radio button).
2. Llamar `archiveSpecOnPN(pnSpecId, [])` para cada spec a archivar.
   - Recordatorio: `archivedAt: null` archiva (semántica invertida de Steelhead).
3. Batching: 10 PNs en paralelo con `Promise.allSettled`.

**Resultados:**
- `archived`: Cantidad de specs archivadas exitosamente.
- `ignored`: PNs ignorados por el usuario.
- `errors`: Array de errores.

### Fase 4: Resumen

Modal con grid de resultados (mismo estilo que `showPendingParamsSummary`):
- PNs procesados
- Specs archivadas
- PNs ignorados
- Errores

Botón de copiar log.

## Config

Nueva acción en `config.json` dentro del grupo de specs:

```json
{
  "id": "resolve-conflicts",
  "label": "Resolver Conflictos de Specs",
  "sublabel": "Detectar y resolver PNs con specs duplicadas",
  "icon": "⚔️",
  "handler": "message",
  "message": "resolve-conflicts",
  "fn": "SpecMigrator.resolveConflicts"
}
```

## Queries y mutations usadas

| Operación | Uso |
|-----------|-----|
| `AllSpecs` (fetchAllExternalSpecs) | Obtener las ~71 specs externas |
| `GetSpec` | Obtener PNs asignados a cada spec |
| `GetPartNumber` | Obtener specs asignadas a cada PN |
| `SpecFieldsAndOptions` | Obtener spec fields de cada spec |
| `ArchivePartNumberSpecAndParams` | Archivar spec del PN |

Todas ya están en `config.json` con sus hashes. No se necesitan queries nuevas.

## Caso edge: 3+ specs con conflicto

Si un PN tiene specs A, B, C donde A y B comparten "Espesor" y A y C comparten "Adherencia", se muestra como una sola tarjeta con las 3 specs como opciones de radio button. El usuario elige cuál conservar; las demás se archivan. Esto resuelve todos los conflictos de ese PN de una vez.

## Caso edge: PN sin conflicto real

Es posible que al momento de escanear, un PN ya no tenga conflicto (porque se resolvió manualmente). El escaneo simplemente no lo incluirá en la lista.
