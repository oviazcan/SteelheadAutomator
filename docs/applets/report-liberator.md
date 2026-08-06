# `report-liberator` — Liberador de Reportes

**Versión:** 0.1.0 · **Estado:** vivo en producción · **Categoría:** Herramientas

> **Nota de procedencia (2026-08-05).** Bitácora escrita *a posteriori*: el applet llevaba tiempo
> vivo en producción **sin figurar en el índice de `CLAUDE.md` ni tener bitácora**. Salió a la luz en
> la auditoría que destapó `cfdi-attacher`. El contenido se derivó de **leer el script y su entrada en
> `config.json`**, no de memoria; lo que no se pudo verificar se marca como pendiente en vez de
> inventarse. Un applet indocumentado no es solo un hueco de doc: **es un applet cuya rotura nadie
> sabe atribuir** — cuando su hash rote, el correo del autopilot dirá un nombre que no le consta a nadie.

## Qué hace

Saca reportes de sus carpetas poniéndoles `folderId = null`, de forma masiva. Lee **todos** los reportes y carpetas, incluidos los archivados.

## Por qué existe

Cuando un reporte queda atrapado en una carpeta con permisos que ya no aplican, deja de ser visible para quien lo necesita. Liberarlo lo devuelve a la raíz.

## Lo que hay que saber antes de tocarlo

Es una operación **masiva y de escritura** sobre la configuración de reportes: exige `MANAGE_REPORTING_SETTINGS`. Toca la misma superficie que el proyecto **Reportes SH** — si se libera un reporte que ese repo sincroniza, la próxima sincronización puede reubicarlo.

## Ficha técnica

| Qué | Detalle |
|---|---|
| Script | `remote/scripts/report-liberator.js` (578 líneas) |
| Inyección | manual (se lanza desde el popup) |
| `urlPatterns` | — |
| Permisos | `MANAGE_REPORTING_SETTINGS` |
| Acción en el popup | Liberar Reportes |

## Pendientes

- [ ] **Sin cobertura de test.** No tiene núcleo puro extraído; cualquier lógica de decisión
      que se le agregue debería salir a un módulo `*-core.js` con su golden test, como manda
      la convención del repo.
- [ ] Bitácora derivada del código, **no de la operación**: falta el relato de incidentes y
      decisiones que solo conoce quien lo usa en piso.
