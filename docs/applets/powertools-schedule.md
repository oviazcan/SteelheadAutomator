# Power Tools `calculateNewSchedule` — reordenar UNSCHEDULED por cuenta prioritaria (`schedule/schedule.ts`)

Hook low-code de la categoría **schedule**. Recibe `inputs.tasks` (mezcla de `STATION_TASK` y `STATION_BATCH_TASK` por shape, todos comparten `status`) y regresa el mismo shape de inputs con `tasks` reordenado y con `expectedStartTime` recalculado para los `UNSCHEDULED`.

## Lo que hace

1. Separa `unscheduledTasks` (`status === "UNSCHEDULED"`) de `otherTasks`.
2. Marca como prioritaria cualquier task cuyo `scheduleTaskElementsByScheduleTaskId[].relatedPartLocations[].accountId` esté en `priorityAccountIds = [1, 5]`.
3. Construye `reorderedUnscheduled = [...prioritarios, ...resto]`.
4. Cumulative time: corre desde `new Date()` (hora del server al ejecutar el hook) y reasigna `expectedStartTime` para cada UNSCHEDULED, sumando `cycleTimeMinutes || expectedDurationMinutes || 0`.
5. Regresa `{...inputs, tasks: [...finalUnscheduled, ...otherTasks]}`.

## Decisiones / gotchas

| Aspecto | Decisión actual | Notas |
|---|---|---|
| `priorityAccountIds` | Hardcoded `[1, 5]` | Pendiente: externalizar a `customInputs` o config de dominio (ver "Oportunidades"). |
| Tasks que no traen `scheduleTaskElementsByScheduleTaskId` | Se tratan como "normales" (no prioritarias) | El shape `STATION_BATCH_TASK` (rrule, stationTaskTypeId) carece de ese campo; `in` check filtra correctamente. |
| `currentTime` arranca en `new Date()` | Server-side, no tz-aware del cliente | Si el panel del scheduler usa zonas distintas, validar que el render de tiempos coincida con lo esperado en operación. |
| Tasks no-UNSCHEDULED | NO se les toca `expectedStartTime` | Solo se reordena el bucket UNSCHEDULED al inicio. |
| Empate de prioridad | Estable (sigue el orden original del filter) | No hay tie-breaker explícito por deadline ni por antigüedad de la WO. |

## Oportunidades (pendientes, dejadas para después)

- **Externalizar `priorityAccountIds`**: leerlas de `inputs.customInputs?.SchedulePriority?.accountIds` o de una variable de dominio. Hoy cualquier cambio requiere editar el hook y volver a push.
- **Tie-breaker por deadline**: dentro del bucket prioritario, ordenar por `workOrder.deadline ASC` antes del cumulative time.
- **Validar que `STATION_BATCH_TASK` no rompa el cumulative time**: usa `expectedDurationMinutes` (ok), pero si la task tiene `rrule` con repeticiones múltiples el tiempo asignado podría ser un single-fire y no reflejar todas las recurrencias.

## Plan de validación pendiente

1. Run el hook en Schedule de Steelhead con tasks reales que tengan al menos un `accountId === 1` o `=== 5`.
2. Verificar que las prioritarias salen primero en el UI del scheduler.
3. Verificar que el `expectedStartTime` cumulative respeta `cycleTimeMinutes` (no se solapan ventanas).
4. Probar con `priorityAccountIds = []` temporal (solo en dev) para confirmar que el resto pasa sin cambios.
