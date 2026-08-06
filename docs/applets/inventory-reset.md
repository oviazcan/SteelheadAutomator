# `inventory-reset` — Reinicio de Inventario

**Versión:** 0.1.0 · **Estado:** vivo en producción · **Categoría:** Inventario

> **Nota de procedencia (2026-08-05).** Bitácora escrita *a posteriori*: el applet llevaba tiempo
> vivo en producción **sin figurar en el índice de `CLAUDE.md` ni tener bitácora**. Salió a la luz en
> la auditoría que destapó `cfdi-attacher`. El contenido se derivó de **leer el script y su entrada en
> `config.json`**, no de memoria; lo que no se pudo verificar se marca como pendiente en vez de
> inventarse. Un applet indocumentado no es solo un hueco de doc: **es un applet cuya rotura nadie
> sabe atribuir** — cuando su hash rote, el correo del autopilot dirá un nombre que no le consta a nadie.

## Qué hace

Archiva los lotes de inventario activos y crea lotes nuevos a partir de un **CSV**. Es la carga inicial / el corte de inventario.

## Por qué existe

Un conteo físico deja el inventario del ERP obsoleto de golpe; reconstruirlo lote por lote a mano no es viable.

## Lo que hay que saber antes de tocarlo

**Es el applet más destructivo del inventario**: archiva lo activo antes de cargar lo nuevo. El permiso declarado es solo `READ_INVENTORY`, que **no refleja** lo que escribe — el servidor valida al ejecutar, pero el gate del menú se queda corto. Antes de correrlo conviene tener el CSV validado y un respaldo del estado previo.

## Ficha técnica

| Qué | Detalle |
|---|---|
| Script | `remote/scripts/inventory-reset.js` (563 líneas) |
| Inyección | manual (se lanza desde el popup) |
| `urlPatterns` | — |
| Permisos | `READ_INVENTORY` |
| Acción en el popup | Reiniciar Inventario |

## Pendientes

- [ ] **Sin cobertura de test.** No tiene núcleo puro extraído; cualquier lógica de decisión
      que se le agregue debería salir a un módulo `*-core.js` con su golden test, como manda
      la convención del repo.
- [ ] Bitácora derivada del código, **no de la operación**: falta el relato de incidentes y
      decisiones que solo conoce quien lo usa en piso.
