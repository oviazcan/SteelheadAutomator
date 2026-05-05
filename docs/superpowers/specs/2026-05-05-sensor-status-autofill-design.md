# Spec: Auto-asignar parámetros "Use for Status" en Sensor Dashboards

**Fecha:** 2026-05-05
**Applet nuevo:** `remote/scripts/sensor-status-autofill.js`
**Bump objetivo:** `config.json` `version` 0.5.56 → 0.5.57

## Problema

En cada **Sensor Dashboard** de Steelhead, cada *member* (sensor mostrado en el dashboard) tiene un radio "Use for Status" que asocia un `SpecFieldParam` (rango/umbral) al sensor para que su última medición se compare contra ese rango y el dashboard pinte verde/rojo. Configurar esto manualmente para dashboards con 100+ members es tedioso: hay que abrir cada member, mirar el radio y marcarlo.

En la mayoría de los casos solo existe **un único** `SpecFieldParam` candidato por member (cuando la spec activa de la estación tiene una sola revisión vigente con un único rango). Esos casos son pura mecánica y se pueden auto-asignar. Cuando hay varios candidatos (varias specs / revisiones aplicables a la estación) se requiere intervención del usuario.

## Diseño

### Comportamiento

Aplicado al dashboard que el usuario tiene abierto en la URL actual:

1. **Pull** del dashboard con `SensorDashboardQuery` → trae todos los members (`sensorDashboardMembersBySensorDashboardId.nodes[]`) ya con sus candidatos embebidos.
2. **Por cada member**, recolectar candidatos en:
   ```
   member.sensorBySensorId
     .sensorTypeBySensorTypeId
     .specFieldsBySensorTypeId.nodes[]
       .specFieldSpecsBySpecFieldId.nodes[]
         .specFieldParamsBySpecFieldSpecId.nodes[]
   ```
3. **Clasificar** según `count = candidates.length` y `active = member.specFieldParamByActiveSpecFieldParamId?.id`:

   | Estado del member | Acción |
   |-------------------|--------|
   | `active != null` | **Skip** "ya asignado" — no se toca aunque haya cambiado el catálogo. |
   | `count == 0` | **Error** "sin candidatos" — el sensor no tiene specFields configurados o la spec no aplica. Se reporta y sigue. |
   | `count == 1` | **Auto-asignar** vía `UpdateSensorDashboardMember(id, activeSpecFieldParamId)`. |
   | `count >= 2` | **Encolar** para ronda asistida; al final de la fase auto, abrir modal por cada uno. |

4. **Fase asistida (≥2 candidatos):** un modal por member con radios para cada candidato, mostrando `<param.name> · <spec.name> (<revision>)` para distinguirlos. Botón "Saltar este member" disponible. Sin "Saltar todos" — un dashboard típico tiene pocos casos múltiples.

5. **Resumen** al final con conteos: asignados auto, asistidos, saltados, sin candidatos, errores.

### Arquitectura

#### Trigger

- **FAB** en el dashboard de sensores (mismo patrón que `paros-linea.js`: detección por URL, ancla al heading o esquina inferior derecha).
- URL pattern del dashboard: detectar `/sensor-dashboards/<idInDomain>` (o el patrón que use Steelhead) y exponer `parseSensorDashboardFromURL()`. La verificación exacta del path se hace en implementación con la URL real abierta en el browser.
- Sin auto-ejecución: solo aparece el FAB; el usuario decide cuándo correr.

#### Scope: un dashboard por corrida

YAGNI — la primera versión opera **solo sobre el dashboard visible**. La opción "todos los dashboards del domain" se evalúa después si hay demanda real. Esto evita batch ciegos sobre 80+ dashboards y mantiene el feedback loop corto.

#### Estructuras

```js
// Por member tras el clasificador:
{
  memberId: number,           // id del SensorDashboardMember
  sensorName: string,
  state: 'already' | 'zero' | 'auto' | 'multi',
  candidates: [{
    id: number,               // SpecFieldParam.id  → activeSpecFieldParamId
    name: string,             // ej "30 - 60 g/L"
    min: number|null, max: number|null, target: number|null,
    specName: string,         // ej "T109-LI (15)"
    specRevision: string,     // ej "Rev. 01"
    specFieldName: string,
  }],
  activeId: number|null,
}
```

#### Queries / mutations

| Op | Tipo | Hash | Origen |
|----|------|------|--------|
| `SensorDashboardQuery` (o nombre real) | query | TBD — capturar via `hash-scanner` al cargar un dashboard | UI Steelhead |
| `UpdateSensorDashboardMember` | mutation | `b903749ed974d573f6167d93393e76f237634bf64ca483d25fbfaff32616f928` | confirmado por el usuario |

Variables de la mutation:
```js
{ id: <member.id>, activeSpecFieldParamId: <param.id> }
```

Variables de la query: `{ idInDomain: <number>, domainId: <number> }` (el shape exacto se confirma en el scan; la respuesta cuelga de `sensorDashboardByIdInDomain`).

Ambos hashes deben agregarse a `remote/config.json` bajo `hashes.queries` / `hashes.mutations` con el mismo formato existente y `usedBy: "sensor-status-autofill"`.

#### Concurrencia

- **Auto-asignación:** secuencial. Estimado 50-100 ms por mutation; un dashboard de 120 members con 100 auto-asignaciones tarda ~10 s. No vale la pena paralelizar y arriesgar rate limits del API.
- **Modales asistidos:** uno a la vez. El usuario controla el ritmo.
- **Cancelación:** botón "Detener" en el progreso aborta el loop entre members. Lo ya asignado se queda asignado (no hay rollback).

#### UI

Reusar el lenguaje visual de `spec-migrator.js` y `invoice-auto-regen.js`:
- Overlay full-screen oscuro con modal centrado (`#1a1a2e`).
- Progress UI con barra y mensaje "Member X de Y · sensor.name".
- Modal de candidatos múltiples con radios y CTA "ASIGNAR" / "SALTAR MEMBER".
- Modal final de resumen con contadores en grid (asignados, asistidos, saltados, errores).

### Data flow

```
FAB click → parseSensorDashboardFromURL() → fetchDashboard(idInDomain)
        → classify(members) → split into [auto[], multi[], zero[], already[]]
        → showProgressUI("Asignando N auto...")
        → for each m in auto: UpdateSensorDashboardMember(m.memberId, m.candidates[0].id)
        → for each m in multi: showCandidatesModal(m) → UpdateSensorDashboardMember(...)
        → showSummary({assigned, assisted, skipped, zero, errors})
```

### Manejo de errores

| Caso | Respuesta |
|------|-----------|
| Hash de query/mutation deprecado | HTTP 400 "Must provide a query string". Aborta corrida con mensaje claro: "Hash desactualizado, corre `hash-scanner` y actualiza `config.json`". Diagnóstico en CLAUDE.md ya documentado. |
| Mutation falla en un member individual | Captura, agrega a `errors[]`, continúa con el siguiente. No reintentos. |
| Member ya tenía param asignado entre el pull y la mutation (race) | El backend no debería rechazar; si lo hace, registra en `errors[]` y sigue. |
| Pull devuelve dashboard vacío (`totalCount == 0`) | Mensaje "Dashboard sin members" y termina. |
| `sensorTypeBySensorTypeId` null o sin `specFieldsBySensorTypeId.nodes` | Cuenta como `count == 0` → error "sin candidatos". |
| Usuario cierra el tab a media corrida | Lo ya mutado queda mutado. La extensión no persiste estado para reanudar; el usuario corre de nuevo y los members ya asignados quedan en `state: 'already'`. |
| Dashboard con > 200 members | Sin paginación necesaria: `SensorDashboardQuery` devuelve todos los members en una sola respuesta (confirmado por scan: `totalCount: 120` en una sola página). Si esto cambia en Steelhead se ajusta. |

### Configuración

- **Action en `config.json`:** agregar `assignSensorStatus` bajo el grupo apropiado del popup (decidir en implementación según el layout vigente; default: el mismo grupo donde vive `paros-linea` ya que comparten contexto de dashboards). Mensaje del background: `assign-sensor-status`.
- **Handler en `extension/background.js`:** nuevo `case 'assign-sensor-status'` que inyecta `sensor-status-autofill.js` y llama `window.SensorStatusAutofill.run()`.
- **Auto-inject:** sí — al estilo `paros-linea`, el applet se carga al detectar la URL del dashboard y muestra el FAB. La acción del popup queda como fallback manual.

## Plan de testing manual

1. **Dashboard mixto** — 1 member sin asignar con 1 candidato → verificar auto-asignación y refresh visual del radio.
2. **Dashboard con caso múltiple** — 1 member con ≥2 candidatos → verificar modal con specName/revision visibles, asignar uno y comprobar persistencia (recargar dashboard).
3. **Dashboard sin candidatos** — sensor TEXT como el del ejemplo (member 7368, `specFieldsBySensorTypeId.nodes: []`) → reporta "sin candidatos" y no rompe.
4. **Dashboard con todos ya asignados** → resumen `assigned: 0, already: N`.
5. **Cancelación a media corrida** → verificar que lo mutado se mantuvo y los pendientes quedaron sin tocar.
6. **Hash deprecado** (forzar mutando temporalmente el hash en config) → mensaje claro de error y log con instrucciones.
7. **Re-corrida** sobre dashboard ya procesado → todos en `already`, sin mutations innecesarias.

## Versionado y deploy

- Bump `config.json`: `version` 0.5.56 → 0.5.57, `lastUpdated` 2026-05-05.
- Agregar entrada de hashes (`SensorDashboardQuery`, `UpdateSensorDashboardMember`) a `config.json`.
- Agregar `sensor-status-autofill` a la lista de scripts cargables y al action group correspondiente.
- Commit `main`: `feat(sensor-status-autofill): auto-asigna SpecFieldParam a members de Sensor Dashboards (0.5.57)`.
- Sync a `gh-pages` siguiendo el procedimiento documentado en CLAUDE.md.
- Push ambas ramas, verificar publicación, recargar la extensión en Chrome.

## Lo que queda fuera del scope

- **"Todos los dashboards del domain"** en una sola corrida — diferido hasta tener evidencia de demanda.
- **Re-asignar members ya asignados** (override) — el applet siempre los respeta. Si el usuario quiere cambiar, lo hace manualmente o pide un toggle en una versión futura.
- **Detección de cambios en el catálogo de specs** — si una spec gana una segunda revisión activa, el applet no notifica; sigue tratando members `already` como cerrados.
- **Persistencia/reanudación** entre corridas — no se guarda estado; cada corrida pull-and-process desde cero.
- **Telemetría / analytics** — solo log a consola (`Steelhead Automator [sensor-status]`).
- **Internacionalización** — UI en español, igual que el resto de los applets.
