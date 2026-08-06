# `portal-importer` — Importador de Portales

**Versión:** 0.1.0 · **Estado:** vivo en producción · **Categoría:** Facturación

> **Nota de procedencia (2026-08-05).** Bitácora escrita *a posteriori*, en la misma pasada que
> destapó `cfdi-attacher` y los otros 7. El applet **se mencionaba** en `CLAUDE.md` pero no tenía
> fila propia en el índice ni ficha. Contenido derivado de **leer el script y su entrada en
> `config.json`**; lo no verificable se marca como pendiente en vez de inventarse.

## Qué hace

Importa el **XLS que los clientes publican en sus portales** (Hubbell y otros) y crea las órdenes de venta correspondientes.

## Por qué existe

Cada cliente publica su pedido en su propio portal con su propio formato. Sin esto, alguien transcribe a mano un Excel ajeno hacia el ERP, línea por línea.

## Lo que hay que saber antes de tocarlo

Es el applet con **más dependencias** del repo (7 scripts, incluidos SheetJS y `ClaudeAPI`), y reutiliza el motor de `po-comparator`.

⚠️ **Marcado `NO-ADOPTADO` en la auditoría de memory hardening.** Carga `host-cleanup-shared.js` pero **no está confirmado el uso de sus helpers**; procesa hojas de cálculo completas en memoria y corre por minutos — el perfil exacto de la skill `memory-hardening-applets`. **Antes de tocarlo, invocarla.**

El flujo de creación de OV y sus trampas están documentados aparte en
[`../api/portal-importer-ov-creation.md`](../api/portal-importer-ov-creation.md).

## Ficha técnica

| Qué | Detalle |
|---|---|
| Script | `remote/scripts/portal-importer.js` (1392 líneas) |
| Scripts que carga | `steelhead-api.js`, `host-cleanup-shared.js`, `claude-api.js`, **`xlsx.full.min.js` (SheetJS)**, `ov-operations.js`, `po-comparator.js`, `portal-importer.js` |
| Inyección | manual (se lanza desde el popup) |
| `urlPatterns` | — |
| Permisos | `READ_RECEIVED_ORDERS` |
| Acción en el popup | Importar Portal |

## Pendientes

- [ ] **Sin cobertura de test propia** (no tiene núcleo puro extraído).
- [ ] Bitácora derivada del código, **no de la operación**: falta el relato de incidentes y
      decisiones que solo conoce quien lo usa en piso.
