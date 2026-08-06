# `po-comparator` — Validador OC vs OV

**Versión:** 0.1.0 · **Estado:** vivo en producción · **Categoría:** Facturación

> **Nota de procedencia (2026-08-05).** Bitácora escrita *a posteriori*, en la misma pasada que
> destapó `cfdi-attacher` y los otros 7. El applet **se mencionaba** en `CLAUDE.md` pero no tenía
> fila propia en el índice ni ficha. Contenido derivado de **leer el script y su entrada en
> `config.json`**; lo no verificable se marca como pendiente en vez de inventarse.

## Qué hace

Lee el **PDF de la orden de compra** del cliente, busca la orden de venta correspondiente y **compara línea por línea**, señalando las diferencias.

## Por qué existe

Capturar a mano una OC de decenas de líneas garantiza errores, y esos errores se descubren hasta la facturación — cuando ya cuestan una nota de crédito.

## Lo que hay que saber antes de tocarlo

**Usa `ClaudeAPI` para interpretar el PDF**: es de los pocos applets con dependencia de un modelo de lenguaje, así que su salida es **sugerencia a revisar**, no verdad. El operador confirma.

Es el **motor** que `po-reconciler` reutiliza (ese lo carga como dependencia). Al cambiar su lógica de comparación, revisar el impacto en los dos.

⚠️ **Marcado `NO-ADOPTADO` en la auditoría de memory hardening** (junto con `portal-importer`) — ver [`memory-hardening-audit.md`](memory-hardening-audit.md). Declara `host-cleanup-shared.js` en sus scripts pero **no está confirmado que use los helpers**. Es un applet de larga duración sobre PDFs grandes: es el perfil exacto que la skill `memory-hardening-applets` cubre.

## Ficha técnica

| Qué | Detalle |
|---|---|
| Script | `remote/scripts/po-comparator.js` (1685 líneas) |
| Scripts que carga | `steelhead-api.js`, `host-cleanup-shared.js`, **`claude-api.js`**, `ov-operations.js`, `po-comparator.js` |
| Inyección | manual (se lanza desde el popup) |
| `urlPatterns` | — |
| Permisos | `READ_RECEIVED_ORDERS` |
| Acción en el popup | Validar OC vs OV |

## Pendientes

- [ ] **Sin cobertura de test propia** (no tiene núcleo puro extraído).
- [ ] Bitácora derivada del código, **no de la operación**: falta el relato de incidentes y
      decisiones que solo conoce quien lo usa en piso.
