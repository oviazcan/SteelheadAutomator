# `po-reconciler` — Reconciliador OV vs PO Schneider

**Versión:** 0.1.0 · **Estado:** vivo en producción · **Categoría:** Órdenes de Venta

> **Nota de procedencia (2026-08-05).** Bitácora escrita *a posteriori*: el applet llevaba tiempo
> vivo en producción **sin figurar en el índice de `CLAUDE.md` ni tener bitácora**. Salió a la luz en
> la auditoría que destapó `cfdi-attacher`. El contenido se derivó de **leer el script y su entrada en
> `config.json`**, no de memoria; lo que no se pudo verificar se marca como pendiente en vez de
> inventarse. Un applet indocumentado no es solo un hueco de doc: **es un applet cuya rotura nadie
> sabe atribuir** — cuando su hash rote, el correo del autopilot dirá un nombre que no le consta a nadie.

## Qué hace

Rebalancea automáticamente las **OVs temporales** contra los **POs reales** de Schneider QRO. Reconoce los PO de SAP por el patrón `^14\d{8}$`.

## Por qué existe

Schneider abre OVs temporales antes de emitir el PO definitivo; sin reconciliar, la facturación queda colgada de un número que no existe en su sistema.

## Lo que hay que saber antes de tocarlo

Es de los applets más grandes del repo (2308 líneas) y **depende de `ClaudeAPI` y de `pdf.min.js`**: lee los PDF de los PO. Tiene spec propia en `docs/superpowers/specs/2026-05-12-po-reconciler-design.md`. Comparte núcleo con `po-comparator`, que está marcado **NO-ADOPTADO** en la auditoría de memoria: al tocarlo, revisar `memory-hardening-applets`.

## Ficha técnica

| Qué | Detalle |
|---|---|
| Script | `remote/scripts/po-reconciler.js` (2308 líneas) |
| Inyección | sí |
| `urlPatterns` | `/Domains/\d+/ReceivedOrders` |
| Permisos | `READ_RECEIVED_ORDERS` |
| Acción en el popup | Reconciliar Schneider QRO |

## Pendientes

- [ ] **Sin cobertura de test.** No tiene núcleo puro extraído; cualquier lógica de decisión
      que se le agregue debería salir a un módulo `*-core.js` con su golden test, como manda
      la convención del repo.
- [ ] Bitácora derivada del código, **no de la operación**: falta el relato de incidentes y
      decisiones que solo conoce quien lo usa en piso.
