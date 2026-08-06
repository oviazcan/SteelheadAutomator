# `wo-deadline` — Gestión Masiva de OT

**Versión:** 0.1.0 · **Estado:** vivo en producción · **Categoría:** Órdenes de Trabajo

> **Nota de procedencia (2026-08-05).** Bitácora escrita *a posteriori*: el applet llevaba tiempo
> vivo en producción **sin figurar en el índice de `CLAUDE.md` ni tener bitácora**. Salió a la luz en
> la auditoría que destapó `cfdi-attacher`. El contenido se derivó de **leer el script y su entrada en
> `config.json`**, no de memoria; lo que no se pudo verificar se marca como pendiente en vez de
> inventarse. Un applet indocumentado no es solo un hueco de doc: **es un applet cuya rotura nadie
> sabe atribuir** — cuando su hash rote, el correo del autopilot dirá un nombre que no le consta a nadie.

## Qué hace

Cambia **plazos (deadlines) y etiquetas** de órdenes de trabajo de forma masiva.

## Por qué existe

Un cambio de programa del cliente mueve decenas de OTs a la vez; hacerlo una por una en la ficha es inviable.

## Lo que hay que saber antes de tocarlo

⚠️ **El `id` de la app (`wo-deadline`) NO coincide con el nombre del archivo (`wo-deadline-changer.js`).** Esa discrepancia es justo la que hizo que la auditoría lo reportara como 'sin script' en el primer pase. Al buscarlo, buscar por el archivo.

## Ficha técnica

| Qué | Detalle |
|---|---|
| Script | `remote/scripts/wo-deadline-changer.js` (ver `remote/scripts/`) |
| Inyección | manual (se lanza desde el popup) |
| `urlPatterns` | — |
| Permisos | `READ_WORK_ORDER` |
| Acción en el popup | Gestionar OTs |

## Pendientes

- [ ] **Sin cobertura de test.** No tiene núcleo puro extraído; cualquier lógica de decisión
      que se le agregue debería salir a un módulo `*-core.js` con su golden test, como manda
      la convención del repo.
- [ ] Bitácora derivada del código, **no de la operación**: falta el relato de incidentes y
      decisiones que solo conoce quien lo usa en piso.
