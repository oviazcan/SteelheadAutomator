# `paros-linea` — Paro de Línea

**Versión:** 0.1.0 · **Estado:** vivo en producción · **Categoría:** Producción

> **Nota de procedencia (2026-08-05).** Bitácora escrita *a posteriori*: el applet llevaba tiempo
> vivo en producción **sin figurar en el índice de `CLAUDE.md` ni tener bitácora**. Salió a la luz en
> la auditoría que destapó `cfdi-attacher`. El contenido se derivó de **leer el script y su entrada en
> `config.json`**, no de memoria; lo que no se pudo verificar se marca como pendiente en vez de
> inventarse. Un applet indocumentado no es solo un hueco de doc: **es un applet cuya rotura nadie
> sabe atribuir** — cuando su hash rote, el correo del autopilot dirá un nombre que no le consta a nadie.

## Qué hace

Skin de operador sobre `MaintenanceEvent` con **botón flotante Andon**: registra paros de línea con cronómetro y evidencia fotográfica.

## Por qué existe

El flujo nativo de mantenimiento tiene demasiados pasos para que un operador lo use con la línea detenida. Aquí el costo de registrar el paro debe ser casi cero, o no se registra.

## Lo que hay que saber antes de tocarlo

Flujo completo: `CreateMaintenanceEvent` (inicio) → `UpdateMaintenanceEvent`/`Comment` (durante) → `CreateMaintenanceNodeEvent` + `CreateManySensorMeasurements` + `UpdateMaintenanceEvent{completedAt}` (al detener) → `/api/files` + `CreateUserFile` + `CreateMaintenanceEventUserFile` (evidencia).

**Es el applet con más historia de hashes rotos del repo**: los dos casos del playbook de persisted queries nacieron aquí (`CurrentUser` deprecada en v0.5.7, `OperatorMaintenanceNodeDialogQuery` rotada en v0.6.24). Ver [`docs/api/persisted-queries-playbook.md`](../api/persisted-queries-playbook.md).

Tiene gate de ruido en consola: sombrea `console` local y suprime `log`/`info` salvo `localStorage.sa_debug === '1'`.

## Ficha técnica

| Qué | Detalle |
|---|---|
| Script | `remote/scripts/paros-linea.js` (1005 líneas) |
| Inyección | sí |
| `urlPatterns` | `/Domains/\d+/Workboards` y `/WorkOrders/\d+` |
| Permisos | `READ_MAINTENANCE` |
| Acción en el popup | Iniciar Paro de Línea · Botón flotante |

## Pendientes

- [ ] **Sin cobertura de test.** No tiene núcleo puro extraído; cualquier lógica de decisión
      que se le agregue debería salir a un módulo `*-core.js` con su golden test, como manda
      la convención del repo.
- [ ] Bitácora derivada del código, **no de la operación**: falta el relato de incidentes y
      decisiones que solo conoce quien lo usa en piso.
